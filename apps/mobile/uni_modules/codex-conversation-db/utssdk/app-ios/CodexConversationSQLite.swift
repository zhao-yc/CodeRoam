import Foundation
import SQLite3

/** 通过单独的串行队列读写应用私有 SQLite，回执交回应用线程。 */
public final class CodexConversationSQLite {
    private struct Row: Codable {
        let key: String
        let value: String
    }

    private struct Snapshot: Encodable {
        let revision: String
        let rows: [Row]
    }

    private struct Changes: Decodable {
        let put: [Row]
        let remove: [String]
        let clear: Bool
    }

    private enum Failure: Error { case operation }
    private static let readKeyBatch = 400
    private static let queue = DispatchQueue(label: "codex.conversation-cache", qos: .utility)
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private static var connection: OpaquePointer?

    /** 读取同一个事务视图中的版本和记录。 */
    static func read(_ namespace: String, selector: String, completion: @escaping (String, Bool) -> Void) {
        queue.async {
            let result = try? readRows(namespace, selector: selector)
            DispatchQueue.main.async { completion(result ?? "", result != nil) }
        }
    }

    /** 成功结果区分提交和版本冲突。异常只回传失败标记。 */
    static func write(_ namespace: String, expected: String, next: String, changes: String, completion: @escaping (Bool, Bool) -> Void) {
        queue.async {
            let result = try? writeRows(namespace, expected: expected, next: next, changes: changes)
            DispatchQueue.main.async { completion(result ?? false, result != nil) }
        }
    }

    /** 在私有 Application Support 下建立持久目录，并排除系统备份。 */
    private static func database() throws -> OpaquePointer {
        if let connection = connection { return connection }
        let files = FileManager.default
        let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var directory = support.appendingPathComponent("CodexConversationCache", isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        var resource = URLResourceValues()
        resource.isExcludedFromBackup = true
        try directory.setResourceValues(resource)
        let path = directory.appendingPathComponent("conversation-cache-v2.sqlite").path
        var handle: OpaquePointer?
        let opened = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil)
        guard opened == SQLITE_OK, let db = handle else {
            if let failed = handle { sqlite3_close(failed) }
            throw Failure.operation
        }
        do {
            guard sqlite3_busy_timeout(db, 3000) == SQLITE_OK else { throw Failure.operation }
            try execute(db, "CREATE TABLE IF NOT EXISTS cache_revisions (namespace TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL)")
            try execute(db, "CREATE TABLE IF NOT EXISTS cache_rows (namespace TEXT NOT NULL, row_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, row_key))")
            connection = db
            return db
        } catch {
            sqlite3_close(db)
            throw error
        }
    }

    /** 静态 SQL 用于建表和事务控制。正文通过参数绑定处理。 */
    private static func execute(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw Failure.operation }
    }

    /** 语句离开作用域时释放资源，包括读写失败的路径。 */
    private static func statement<T>(_ db: OpaquePointer, _ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var handle: OpaquePointer?
        let prepared = sqlite3_prepare_v2(db, sql, -1, &handle, nil)
        guard prepared == SQLITE_OK, let preparedStatement = handle else {
            if let failed = handle { sqlite3_finalize(failed) }
            throw Failure.operation
        }
        defer { sqlite3_finalize(preparedStatement) }
        return try body(preparedStatement)
    }

    /** 明确按 UTF-8 字节长度绑定，避免原生缓冲区截断正文。 */
    private static func bind(_ value: String, _ query: OpaquePointer, _ index: Int32) throws {
        let bytes = value.utf8CString
        let result = bytes.withUnsafeBufferPointer { buffer in
            sqlite3_bind_text(query, index, buffer.baseAddress, Int32(buffer.count - 1), transient)
        }
        guard result == SQLITE_OK else { throw Failure.operation }
    }

    /** 复制当前行的字符串，下一次 step 后仍可使用。 */
    private static func text(_ query: OpaquePointer, _ index: Int32) -> String {
        guard let bytes = sqlite3_column_text(query, index) else { return "" }
        return String(decoding: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_column_bytes(query, index))), as: UTF8.self)
    }

    /** 复合主键只读取目标范围，分批请求在一个只读事务中取得一致版本。 */
    private static func readRows(_ namespace: String, selector: String) throws -> String {
        guard !namespace.isEmpty else { throw Failure.operation }
        let keys: [String]?
        if selector.isEmpty || selector == "headers" {
            keys = nil
        } else {
            let requested = try JSONDecoder().decode([String].self, from: Data(selector.utf8))
            var seen = Set<String>()
            keys = requested.filter { seen.insert($0).inserted }
        }
        let db = try database()
        var revision = ""
        var rows: [Row] = []
        func collect(_ condition: String?, _ bindings: [String]) throws {
            let sql = condition.map { "SELECT meta.revision, rows.row_key, rows.value FROM cache_revisions AS meta LEFT JOIN cache_rows AS rows ON rows.namespace = meta.namespace\($0) WHERE meta.namespace = ?" }
                ?? "SELECT revision, NULL, NULL FROM cache_revisions WHERE namespace = ?"
            try statement(db, sql) { query in
                for (index, value) in (bindings + [namespace]).enumerated() {
                    try bind(value, query, Int32(index + 1))
                }
                var state = sqlite3_step(query)
                while state == SQLITE_ROW {
                    revision = text(query, 0)
                    if sqlite3_column_type(query, 1) != SQLITE_NULL {
                        rows.append(Row(key: text(query, 1), value: text(query, 2)))
                    }
                    state = sqlite3_step(query)
                }
                guard state == SQLITE_DONE else { throw Failure.operation }
            }
        }
        if selector == "headers" {
            try collect(" AND rows.row_key >= ? AND rows.row_key < ?", ["h:", "h;"])
        } else if let keys = keys {
            if keys.isEmpty {
                try collect(nil, [])
            } else {
                let grouped = keys.count > readKeyBatch
                if grouped { try execute(db, "BEGIN DEFERRED") }
                var committed = false
                defer { if grouped && !committed { _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil) } }
                for start in stride(from: 0, to: keys.count, by: readKeyBatch) {
                    let group = Array(keys[start..<min(start + readKeyBatch, keys.count)])
                    let placeholders = Array(repeating: "?", count: group.count).joined(separator: ",")
                    try collect(" AND rows.row_key IN (\(placeholders))", group)
                }
                if grouped { try execute(db, "COMMIT"); committed = true }
            }
        } else {
            try collect("", [])
        }
        let snapshot = Snapshot(revision: revision, rows: rows)
        return String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
    }

    /** 版本检查、删除和更新共同提交，任一步失败都回滚。 */
    private static func writeRows(_ namespace: String, expected: String, next: String, changes: String) throws -> Bool {
        guard !namespace.isEmpty, !next.isEmpty, next != expected else { throw Failure.operation }
        let batch = try JSONDecoder().decode(Changes.self, from: Data(changes.utf8))
        let db = try database()
        try execute(db, "BEGIN IMMEDIATE")
        var committed = false
        defer { if !committed { _ = sqlite3_exec(db, "ROLLBACK", nil, nil, nil) } }
        let current = try statement(db, "SELECT revision FROM cache_revisions WHERE namespace = ?") { query in
            try bind(namespace, query, 1)
            let state = sqlite3_step(query)
            if state == SQLITE_ROW { return text(query, 0) }
            if state == SQLITE_DONE { return "" }
            throw Failure.operation
        }
        guard current == expected else { return false }
        if batch.clear {
            try statement(db, "DELETE FROM cache_rows WHERE namespace = ?") { query in
                try bind(namespace, query, 1)
                guard sqlite3_step(query) == SQLITE_DONE else { throw Failure.operation }
            }
        }
        if !batch.remove.isEmpty {
            try statement(db, "DELETE FROM cache_rows WHERE namespace = ? AND row_key = ?") { query in
                try bind(namespace, query, 1)
                for key in batch.remove {
                    try bind(key, query, 2)
                    guard sqlite3_step(query) == SQLITE_DONE, sqlite3_reset(query) == SQLITE_OK else { throw Failure.operation }
                }
            }
        }
        if !batch.put.isEmpty {
            try statement(db, "INSERT OR REPLACE INTO cache_rows (namespace, row_key, value) VALUES (?, ?, ?)") { query in
                try bind(namespace, query, 1)
                for row in batch.put {
                    try bind(row.key, query, 2)
                    try bind(row.value, query, 3)
                    guard sqlite3_step(query) == SQLITE_DONE, sqlite3_reset(query) == SQLITE_OK else { throw Failure.operation }
                }
            }
        }
        try statement(db, "INSERT OR REPLACE INTO cache_revisions (namespace, revision) VALUES (?, ?)") { query in
            try bind(namespace, query, 1)
            try bind(next, query, 2)
            guard sqlite3_step(query) == SQLITE_DONE else { throw Failure.operation }
        }
        try execute(db, "COMMIT")
        committed = true
        return true
    }
}
