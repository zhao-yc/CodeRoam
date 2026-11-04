package uts.sdk.modules.codexConversationDb

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** 单进程的聊天缓存读写共用一个后台队列和私有数据库。 */
object CodexConversationSQLite {
    private const val READ_KEY_BATCH = 400
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var connection: SQLiteDatabase? = null

    /** 数据库保存在应用的非备份目录，旧客户端清理不会触碰系统其他数据。 */
    private fun database(context: Context): SQLiteDatabase {
        connection?.let { return it }
        val opened = SQLiteDatabase.openOrCreateDatabase(File(context.noBackupFilesDir, "conversation-cache-v2.sqlite"), null)
        try {
            opened.execSQL("CREATE TABLE IF NOT EXISTS cache_revisions (namespace TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL)")
            opened.execSQL("CREATE TABLE IF NOT EXISTS cache_rows (namespace TEXT NOT NULL, row_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, row_key))")
            connection = opened
            return opened
        } catch (failure: Exception) {
            opened.close()
            throw failure
        }
    }

    /** 只回传成功标记，不让含聊天数据的异常或 SQL 参数进入日志。 */
    private fun <T : Any> execute(fallback: T, completion: (T, Boolean) -> Unit, operation: () -> T) {
        worker.execute {
            val result = try { operation() } catch (_: Exception) { null }
            main.post { completion(result ?: fallback, result != null) }
        }
    }

    /** 复合主键限定命名空间和记录范围。超出绑定上限的分批查询共用同一事务视图。 */
    fun read(context: Context, namespace: String, selector: String, completion: (String, Boolean) -> Unit) {
        execute("", completion) {
            require(namespace.isNotEmpty())
            val keys = if (selector == "" || selector == "headers") null else {
                val requested = JSONArray(selector)
                (0 until requested.length()).map { requested.get(it) as String }.distinct()
            }
            val db = database(context)
            val rows = JSONArray()
            var revision = ""
            fun collect(condition: String?, bindings: List<String>) {
                val sql = if (condition == null) "SELECT revision, NULL, NULL FROM cache_revisions WHERE namespace = ?" else
                    "SELECT meta.revision, rows.row_key, rows.value FROM cache_revisions AS meta LEFT JOIN cache_rows AS rows ON rows.namespace = meta.namespace$condition WHERE meta.namespace = ?"
                db.rawQuery(sql, (bindings + namespace).toTypedArray()).use { cursor ->
                    while (cursor.moveToNext()) {
                        revision = cursor.getString(0)
                        if (!cursor.isNull(1)) rows.put(JSONObject().put("key", cursor.getString(1)).put("value", cursor.getString(2)))
                    }
                }
            }
            when {
                selector == "headers" -> collect(" AND rows.row_key >= ? AND rows.row_key < ?", listOf("h:", "h;"))
                keys == null -> collect("", emptyList())
                keys.isEmpty() -> collect(null, emptyList())
                else -> {
                    val grouped = keys.size > READ_KEY_BATCH
                    if (grouped) db.beginTransactionNonExclusive()
                    try {
                        keys.chunked(READ_KEY_BATCH).forEach { group ->
                            collect(" AND rows.row_key IN (${group.joinToString(",") { "?" }})", group)
                        }
                        if (grouped) db.setTransactionSuccessful()
                    } finally {
                        if (grouped) db.endTransaction()
                    }
                }
            }
            JSONObject().put("revision", revision).put("rows", rows).toString()
        }
    }

    /** 在同一事务内核对版本、更新变更记录并提交下一版本。 */
    fun write(context: Context, namespace: String, expected: String, next: String, changes: String, completion: (Boolean, Boolean) -> Unit) {
        execute(false, completion) { writeRows(database(context), namespace, expected, next, changes) }
    }

    /** 升级只清理历史正文行，独立命名空间的列表摘要及其他记录不参与。 */
    fun purgeBodies(context: Context, completion: (Boolean, Boolean) -> Unit) {
        execute(false, completion) {
            val db = database(context)
            db.beginTransactionNonExclusive()
            try {
                db.delete("cache_rows", "substr(namespace, 1, 15) <> ? AND substr(row_key, 1, 2) IN (?, ?)", arrayOf("thread-list-v1:", "h:", "m:"))
                db.setTransactionSuccessful()
                true
            } finally {
                db.endTransaction()
            }
        }
    }

    private fun writeRows(db: SQLiteDatabase, namespace: String, expected: String, next: String, changes: String): Boolean {
        require(namespace.isNotEmpty() && next.isNotEmpty() && next != expected)
        val mutation = JSONObject(changes)
        val clear = mutation.get("clear") as Boolean
        val remove = mutation.getJSONArray("remove")
        val put = mutation.getJSONArray("put")
        db.beginTransactionNonExclusive()
        try {
            val current = db.rawQuery("SELECT revision FROM cache_revisions WHERE namespace = ?", arrayOf(namespace)).use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else ""
            }
            if (current != expected) return false
            if (clear) db.delete("cache_rows", "namespace = ?", arrayOf(namespace))
            if (remove.length() > 0) db.compileStatement("DELETE FROM cache_rows WHERE namespace = ? AND row_key = ?").use { statement ->
                statement.bindString(1, namespace)
                for (i in 0 until remove.length()) {
                    statement.bindString(2, remove.get(i) as String)
                    statement.execute()
                }
            }
            if (put.length() > 0) db.compileStatement("INSERT OR REPLACE INTO cache_rows (namespace, row_key, value) VALUES (?, ?, ?)").use { statement ->
                statement.bindString(1, namespace)
                for (i in 0 until put.length()) {
                    val row = put.getJSONObject(i)
                    statement.bindString(2, row.get("key") as String)
                    statement.bindString(3, row.get("value") as String)
                    statement.execute()
                }
            }
            db.execSQL("INSERT OR REPLACE INTO cache_revisions (namespace, revision) VALUES (?, ?)", arrayOf(namespace, next))
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }
}
