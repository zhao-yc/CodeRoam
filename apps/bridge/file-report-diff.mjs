import { BridgeError } from '../../packages/protocol/contracts.mjs';

const visualizationPath = /(?:^|[\\/])(?:\.codex|(?:\.codex-workspaces|OpenAI[\\/]Codex[\\/]workspaces)(?:[\\/]instances[\\/][0-9a-f-]+)?)[\\/]visualizations[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][\w-]+[\\/][a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const diffMetadata = /^(?:index |old mode |new mode |new file mode |deleted file mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |--- |\+\+\+ )/;

function invalidDiff() {
  return new BridgeError('REPORT_INCOMPLETE', '这份报告的文件差异格式不完整');
}

/** 校验 hunk 声明的两侧长度，避免将文件头、二进制正文和截断行当作文本修改。 */
function updateDiff(diff, moved) {
  let additions = 0, deletions = 0, oldLines = 0, newLines = 0;
  let header = false, hunks = false, fileChange = moved;
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line === '\\ No newline at end of file') continue;
    if (oldLines || newLines) {
      switch (line[0]) {
        case ' ': oldLines--; newLines--; break;
        case '+': newLines--; additions++; break;
        case '-': oldLines--; deletions++; break;
        default: throw invalidDiff();
      }
      if (oldLines < 0 || newLines < 0) throw invalidDiff();
      continue;
    }
    if (line.startsWith('@@')) {
      const match = hunkHeader.exec(line);
      if (!match) throw invalidDiff();
      oldLines = Number(match[1] ?? 1);
      newLines = Number(match[2] ?? 1);
      if (!Number.isSafeInteger(oldLines) || !Number.isSafeInteger(newLines)) throw invalidDiff();
      hunks = true;
    } else if (line.startsWith('diff --git ')) {
      if (header || hunks) throw invalidDiff();
      header = true;
    } else if (!hunks && (line === 'GIT binary patch' || /^Binary files .+ and .+ differ$/.test(line))) {
      return { additions: 0, deletions: 0, binary: true, diff };
    } else if (line !== '' && (hunks || !diffMetadata.test(line))) {
      throw invalidDiff();
    } else if (/^(?:new mode |new file mode |deleted file mode |(?:rename|copy) to )/.test(line)) {
      fileChange = true;
    }
  }
  if (oldLines || newLines || !(hunks || fileChange)) throw invalidDiff();
  return { additions, deletions, binary: false, diff };
}

function diffPath(prefix, filePath) {
  const fullPath = prefix + filePath;
  return /[\u0000-\u001f"\\]/u.test(fullPath) ? JSON.stringify(fullPath) : fullPath;
}

/** 新增和删除的 diff 字段存储整份文件正文，空文件仍保留文件记录。 */
function wholeFileDiff(filePath, text, added) {
  const oldPath = diffPath('a/', filePath), newPath = diffPath('b/', filePath);
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const count = lines.length;
  const header = [
    'diff --git ' + oldPath + ' ' + newPath,
    added ? 'new file mode 100644' : 'deleted file mode 100644',
    '--- ' + (added ? '/dev/null' : oldPath),
    '+++ ' + (added ? newPath : '/dev/null'),
  ];
  if (count) {
    header.push(added ? '@@ -0,0 +1,' + count + ' @@' : '@@ -1,' + count + ' +0,0 @@');
    for (const line of lines) header.push((added ? '+' : '-') + line);
    if (!text.endsWith('\n')) header.push('\\ No newline at end of file');
  }
  return { additions: added ? count : 0, deletions: added ? 0 : count, binary: false, diff: header.join('\n') + '\n' };
}

/** 从已订阅会话的结构化变更回退生成汇总，保留同一文件的每次修改顺序。 */
export function reportFromDiffs(batches) {
  const files = new Map();
  let additions = 0, deletions = 0;
  for (const { changes } of batches) for (const change of changes) {
    const kind = change.kind.type;
    const filePath = kind === 'update' ? change.kind.move_path ?? change.path : change.path;
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw invalidDiff();
    if (visualizationPath.test(filePath)) continue;
    const diff = change.diff.replaceAll('\r\n', '\n');
    const parsed = kind === 'update' ? updateDiff(diff, filePath !== change.path) : wholeFileDiff(filePath, diff, kind === 'add');
    let file = files.get(filePath);
    if (!file) {
      file = { path: filePath, kind, additions: 0, deletions: 0, binary: false, diffs: [] };
      files.set(filePath, file);
    }
    if (kind === 'delete' || file.kind !== 'add') file.kind = kind;
    file.additions += parsed.additions;
    file.deletions += parsed.deletions;
    file.binary ||= parsed.binary;
    file.diffs.push(parsed.diff);
    additions += parsed.additions;
    deletions += parsed.deletions;
  }
  return { additions, deletions, files: [...files.values()] };
}
