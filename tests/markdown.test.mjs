import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { performance } from 'node:perf_hooks';

// 直接执行手机使用的 UTS 文件，不使用解析器副本、DOM 或第三方库。
const source = fs.readFileSync(new URL('../apps/mobile/services/markdown.uts', import.meta.url), 'utf8');
const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
const { parseMarkdown, safeWebUrl } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const text = block => block.runs.map(run => run.text).join('');
const runs = input => parseMarkdown(input).flatMap(block => block.runs);
const links = input => runs(input).filter(run => run.href !== '');
const cellText = cell => cell.map(run => run.text).join('');

test('空输入和空白没有虚假块，固定接口的全部字段均初始化', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(' \t\r\n\n'), []);
  const blocks = parseMarkdown('# 标题\n\n正文\n\n- 项目\n\n> 引用\n\n---\n\n```ts\n代码\n```\n\n| 列 |\n| --- |\n| 值 |\n\n![替代文字](https://example.com/image.png)');
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'paragraph', 'list', 'quote', 'rule', 'code', 'table', 'image']);
  const fields = ['id', 'kind', 'runs', 'depth', 'marker', 'level', 'language', 'code', 'rows', 'src', 'alt'].sort();
  const runFields = ['text', 'bold', 'italic', 'strike', 'code', 'href'].sort();
  assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length);
  assert.deepEqual(blocks, parseMarkdown('# 标题\n\n正文\n\n- 项目\n\n> 引用\n\n---\n\n```ts\n代码\n```\n\n| 列 |\n| --- |\n| 值 |\n\n![替代文字](https://example.com/image.png)'));
  for (const block of blocks) {
    assert.deepEqual(Object.keys(block).sort(), fields);
    for (const field of ['id', 'kind', 'marker', 'language', 'code', 'src', 'alt']) assert.equal(typeof block[field], 'string');
    for (const field of ['depth', 'level']) assert.equal(typeof block[field], 'number');
    assert.ok(Array.isArray(block.rows));
    assert.ok(Array.isArray(block.runs));
    for (const run of [...block.runs, ...block.rows.flatMap(row => row.cells.flat())]) {
      assert.deepEqual(Object.keys(run).sort(), runFields);
      assert.equal(typeof run.text, 'string');
      assert.equal(typeof run.href, 'string');
      for (const field of ['bold', 'italic', 'strike', 'code']) assert.equal(typeof run[field], 'boolean');
    }
  }
});

test('六级 ATX、Setext 标题、段落软换行及分隔线按块解析', () => {
  const blocks = parseMarkdown('# 一 #\n## 二\n### 三\n#### 四\n##### 五\n###### 六\n\n第一行\n第二行\n\n下划线标题\n===\n\n次级标题\n---\n\n***\n_ _ _\n- - -\n\n####### 普通文字\n#没有空格');
  assert.deepEqual(blocks.slice(0, 6).map(block => block.level), [1, 2, 3, 4, 5, 6]);
  assert.equal(text(blocks[0]), '一');
  assert.equal(text(blocks[6]), '第一行\n第二行');
  assert.deepEqual(blocks.slice(7, 9).map(block => [block.kind, block.level]), [['heading', 1], ['heading', 2]]);
  assert.deepEqual(blocks.slice(9, 12).map(block => block.kind), ['rule', 'rule', 'rule']);
  assert.equal(text(blocks[12]), '####### 普通文字\n#没有空格');
});

test('粗体、斜体、删除线及嵌套样式可组合且不污染相邻文字', () => {
  for (const [input, expected] of [
    ['**粗体**', { bold: true }], ['__粗体__', { bold: true }],
    ['*斜体*', { italic: true }], ['_斜体_', { italic: true }],
    ['~~删除~~', { strike: true }], ['***组合***', { bold: true, italic: true }],
    ['___组合___', { bold: true, italic: true }],
    ['~~**组合**~~', { bold: true, strike: true }],
    ['**_~~组合~~_**', { bold: true, italic: true, strike: true }],
  ]) {
    const result = runs(`前 ${input} 后`);
    const middle = result.find(run => run.text.includes('体') || run.text.includes('删除') || run.text.includes('组合'));
    for (const field of ['bold', 'italic', 'strike']) assert.equal(middle[field], expected[field] ?? false, `${input}: ${field}`);
    assert.equal(result[0].bold || result[0].italic || result[0].strike, false);
    assert.equal(result.at(-1).bold || result.at(-1).italic || result.at(-1).strike, false);
  }
  const nested = runs('**外层 *内层* 外层**');
  assert.deepEqual(nested.map(run => [run.text, run.bold, run.italic]), [['外层 ', true, false], ['内层', true, true], [' 外层', true, false]]);
  assert.equal(text(parseMarkdown('snake_case_name 和 a_b_c')[0]), 'snake_case_name 和 a_b_c');
  assert.ok(runs('snake_case_name 和 a_b_c').every(run => !run.italic));
});

test('未闭合行内样式保留标记和可读文字，不把后续请求的状态带入下一次解析', () => {
  for (const input of ['**未完成', '*未完成', '__未完成', '~~未完成', '**外层 *完整*']) {
    assert.ok(runs(input).map(run => run.text).join('').includes('未完成') || input.includes('外层'));
  }
  assert.equal(text(parseMarkdown('**未完成')[0]), '**未完成');
  assert.equal(text(parseMarkdown('普通文字')[0]), '普通文字');
  assert.equal(runs('普通文字')[0].bold, false);
});

test('反斜杠转义标记和中文标点保留原文', () => {
  const input = String.raw`\*不斜体\* \_下划线\_ \~删除线\~ \[非链接\]\(https://example.com\) \!图片 \\ 路径`;
  const result = runs(input);
  assert.equal(result.map(run => run.text).join(''), '*不斜体* _下划线_ ~删除线~ [非链接](https://example.com) !图片 \\ 路径');
  assert.ok(result.every(run => !run.bold && !run.italic && !run.strike && run.href === ''));
  assert.equal(text(parseMarkdown('中文，标点。保持！？【原文】')[0]), '中文，标点。保持！？【原文】');
});

test('有序无序列表保留编号与嵌套层级、同级退回及续行', () => {
  const blocks = parseMarkdown('- 父项\n  1. 子项\n     + 孙项\n  2) 子项二\n- 父项二\n  续行\n\n普通段落\n\n9. 第九项\n10. 第十项');
  assert.deepEqual(blocks.map(block => [block.kind, block.depth, block.marker]), [
    ['list', 0, '-'], ['list', 1, '1.'], ['list', 2, '+'], ['list', 1, '2)'],
    ['list', 0, '-'], ['paragraph', 0, ''], ['list', 0, '9.'], ['list', 0, '10.'],
  ]);
  assert.equal(text(blocks[4]), '父项二\n续行');
  assert.deepEqual(parseMarkdown('-\n- 空项之后').map(block => block.marker), ['-', '-']);
});

test('引用及引用中的列表、标题、围栏采用扁平块层级', () => {
  const blocks = parseMarkdown('> 外层\n>> 内层\n> - 引用列表\n>   - 子项\n\n> ## 引用标题\n>\n> ```txt\n> https://example.com\n> ```\n\n退出引用');
  assert.deepEqual(blocks.map(block => [block.kind, block.depth]), [
    ['quote', 0], ['quote', 1], ['list', 1], ['list', 2], ['heading', 0], ['code', 0], ['paragraph', 0],
  ]);
  assert.equal(blocks[5].code, 'https://example.com\n');
  assert.deepEqual(blocks[5].runs, []);
});

test('列表中的引用、交替容器及子列表之后的父段落保留所属层级', () => {
  const blocks = parseMarkdown('- 父项\n  > 引用\n  > > 内层\n- 同级');
  assert.deepEqual(blocks.map(block => [block.kind, block.depth]), [['list', 0], ['quote', 1], ['quote', 2], ['list', 0]]);
  const quotedList = parseMarkdown('> - 项目\n>   > 子引用\n>   > > 孙引用');
  assert.deepEqual(quotedList.map(block => [block.kind, block.depth]), [['list', 1], ['quote', 2], ['quote', 3]]);
  const paragraphs = parseMarkdown('- 父项\n  - 子项\n\n  父段落\n\n结束');
  assert.equal(paragraphs[2].depth, 1);
  assert.equal(paragraphs[3].depth, 0);
});

test('行内代码跳过所有链接和样式，支持不同长度定界符与内部反引号', () => {
  const input = '前 `**代码** [链接](https://example.com) https://example.com` 后 `` `内部` ``';
  const result = runs(input);
  assert.deepEqual(result.filter(run => run.code).map(run => run.text), ['**代码** [链接](https://example.com) https://example.com', '`内部`']);
  assert.ok(result.every(run => run.href === ''));
  assert.equal(runs('` 未完成 https://example.com')[0].code, true);
  assert.equal(links('` 未完成 https://example.com').length, 0);
  assert.equal(runs('`a\nb`')[0].text, 'a b');
  assert.equal(runs('`   `')[0].text, '   ');
  assert.equal(runs('`代码\\` 后 https://example.com')[0].text, '代码\\');
  assert.equal(links('`代码\\` 后 https://example.com')[0].href, 'https://example.com');
});

test('围栏代码保留代码内容和实际末尾换行，语言取首个信息词', () => {
  const block = parseMarkdown('```typescript title="例子"\nconst a = 1\n\nhttps://example.com\n```')[0];
  assert.equal(block.kind, 'code');
  assert.equal(block.language, 'typescript');
  assert.equal(block.code, 'const a = 1\n\nhttps://example.com\n');
  assert.deepEqual(block.runs, []);
  assert.deepEqual(parseMarkdown('```\n```')[0].code, '');
  assert.equal(parseMarkdown('```\n\n```')[0].code, '\n');
  assert.equal(parseMarkdown('```\na\n```\n')[0].code, 'a\n');
});

test('未闭合围栏随流式输入保留实际换行，CRLF 与单独 CR 规范化为 LF', () => {
  for (const [input, expected] of [
    ['```js', ''], ['```js\na', 'a'], ['```js\na\n', 'a\n'],
    ['```js\na\n\n', 'a\n\n'], ['```js\r\na\r\n```', 'a\n'],
    ['```js\ra\r```', 'a\n'],
  ]) assert.equal(parseMarkdown(input)[0].code, expected, JSON.stringify(input));
});

test('围栏关闭要求同字符、足够长度、纯空白尾部，代码中标记仍是代码', () => {
  const input = '````js\n```\n~~~~\n````尾部\n> 引用\n- 列表\n[文字](https://example.com)\n````\n\n尾段';
  const blocks = parseMarkdown(input);
  assert.equal(blocks[0].code, '```\n~~~~\n````尾部\n> 引用\n- 列表\n[文字](https://example.com)\n');
  assert.equal(text(blocks[1]), '尾段');
  assert.equal(parseMarkdown('~~~txt\n正文\n~~~~')[0].code, '正文\n');
});

test('列表内的围栏及缩进代码不把代码网址变为链接', () => {
  const blocks = parseMarkdown('- 项目\n  ```js\n  https://example.com\n  ```\n\n    https://example.org\n    **代码**');
  assert.equal(blocks[1].kind, 'code');
  assert.equal(blocks[1].depth, 1);
  assert.equal(blocks[1].code, 'https://example.com\n');
  assert.ok(blocks.filter(block => block.kind === 'code').every(block => block.runs.length === 0));
});

test('列表首行直接开启围栏，代码关闭后正确恢复列表及外层段落', () => {
  const blocks = parseMarkdown('- ```js\n  https://example.com\n  ```\n- 下一项\n\n正文');
  assert.deepEqual(blocks.map(block => block.kind), ['code', 'list', 'paragraph']);
  assert.equal(blocks[0].marker, '-');
  assert.equal(blocks[0].depth, 0);
  assert.equal(blocks[0].language, 'js');
  assert.equal(blocks[0].code, 'https://example.com\n');
  const quoted = parseMarkdown('- 父项\n  > ```\n  > a\n  > ```');
  assert.equal(quoted[1].kind, 'code');
  assert.equal(quoted[1].depth, 1);
  assert.equal(quoted[1].code, 'a\n');
});

test('Markdown 链接支持平衡括号、转义括号、带标题与尖括号目标', () => {
  for (const [input, expected, label] of [
    ['[文档](https://example.com/a_(b(c)))', 'https://example.com/a_(b(c))', '文档'],
    [String.raw`[文\]档](https://example.com/a\(b\))`, 'https://example.com/a(b)', '文]档'],
    ['[文档](https://example.com "中文标题")', 'https://example.com', '文档'],
    ["[文档](https://example.com '标题')", 'https://example.com', '文档'],
    ['[文档](<https://example.com/a_(b)> "标题")', 'https://example.com/a_(b)', '文档'],
    ['[文档](https://example.com "标题含 ) 和 ( 括号")', 'https://example.com', '文档'],
    [String.raw`[文档](https://example.com "含转义\"引号")`, 'https://example.com', '文档'],
  ]) {
    assert.equal(links(input).map(run => run.href).join(''), expected, input);
    assert.equal(text(parseMarkdown(input)[0]), label, input);
  }
});

test('链接标签支持嵌套样式，行内代码不附加链接', () => {
  const result = runs('[**粗体** 和 *斜体* 与 `代码`](https://example.com)');
  assert.ok(result.find(run => run.text === '粗体').bold);
  assert.ok(result.find(run => run.text === '斜体').italic);
  assert.equal(result.find(run => run.text === '代码').code, true);
  assert.equal(result.find(run => run.text === '代码').href, '');
  assert.ok(result.filter(run => !run.code).every(run => run.href === 'https://example.com'));
});

test('流式链接在最后闭括号到来前始终不可点击，完成后才启用', () => {
  const input = '[**文档**](https://example.com/a_(b))';
  for (let end = 1; end < input.length; end++) {
    const fragment = input.slice(0, end);
    assert.equal(links(fragment).length, 0, fragment);
    assert.ok(runs(fragment).map(run => run.text).join('').length > 0);
  }
  assert.equal(links(input)[0].href, 'https://example.com/a_(b)');
  for (const input of ['[文档](https://', '[文档](https://example.com', '[文档](https://example.com "未完成)', '[https://example.com', '[文档](https://example.com/a_(b)']) {
    assert.equal(links(input).length, 0, input);
    assert.equal(text(parseMarkdown(input)[0]), input);
  }
});

test('非法和本地链接完整保留文字，绝不降级为内部裸链接', () => {
  for (const target of ['javascript:alert(1)', 'data:text/html,abc', 'file:///tmp/a', '/tmp/a', './a', '../a', 'C:/a', 'C:\\a', '//example.com', 'mailto:user@example.com', 'https://', 'https://example.com/%', 'https://example.com 未闭标题']) {
    const input = `[文档](${target})`;
    assert.equal(links(input).length, 0, input);
    assert.equal(text(parseMarkdown(input)[0]), input);
  }
  assert.equal(links('/tmp/https://example.com C:\\https://example.com file:///https://example.com').length, 0);
});

test('裸网址支持中文邻接、查询串、片段、平衡括号与外层标点', () => {
  const input = '见https://example.com/路径?q=中文&x=1#片段，另见（https://example.org/a_(b)）。(https://example.net/a).';
  assert.deepEqual(links(input).map(run => run.href), ['https://example.com/路径?q=中文&x=1#片段', 'https://example.org/a_(b)', 'https://example.net/a']);
  assert.equal(runs(input).map(run => run.text).join(''), input);
  assert.equal(links('https://example.com/a_(b(c))!')[0].href, 'https://example.com/a_(b(c))');
  assert.equal(links('https://example.com/?a=1&b=2')[0].href, 'https://example.com/?a=1&b=2');
  assert.equal(links('HTTPS://EXAMPLE.COM')[0].href, 'HTTPS://EXAMPLE.COM');
  assert.equal(links('abcHTTPS://example.com').length, 0);
});

test('裸网址和显式尖括号网址不吞掉相邻强调结束符', () => {
  for (const input of ['*https://example.com*', '**https://example.com**', '_https://example.com_', '~~https://example.com~~']) {
    assert.equal(links(input)[0].href, 'https://example.com', input);
    assert.equal(runs(input).map(run => run.text).join(''), 'https://example.com', input);
  }
  assert.equal(links('<https://example.com/a_(b)>')[0].href, 'https://example.com/a_(b)');
});

test('安全网址校验接受完整 HTTP/HTTPS、域名、IPv4、IPv6 和端口', () => {
  for (const input of ['http://example.com', 'HTTPS://Example.com/path?q=1#hash', 'https://例子.测试/中文', 'http://127.0.0.1:8080/a', 'http://[::1]:8080/a', 'https://[2001:db8::1]/', 'http://[::ffff:192.0.2.1]/', 'http://[2001:db8:0:0:0:0:0:1]/', 'https://example.com/a%20b', 'https://example.com/a_(b)']) assert.equal(safeWebUrl(input), input);
  assert.equal(safeWebUrl('  https://example.com  '), 'https://example.com');
});

test('安全网址校验拒绝协议变体、控制字符、畸形主机端口和未完成转义', () => {
  for (const input of ['', 'example.com', '//example.com', 'ftp://example.com', 'file:///tmp/a', 'javascript:alert(1)', 'http:/example.com', 'https://', 'https:///path', 'https://?a', 'https://#hash', 'https://user:password@example.com', 'https://example.com\\@evil.test', 'https://example.com\n/path', 'https://example.com/\u202eabc', 'https://example.com/<script>', 'https://example.com/"x', 'https://example.com/%', 'https://example.com/%GG', 'https://example.com/%0a', 'https://example.com/%0D', 'https://example.com/%00', 'https://example..com', 'https://-example.com', 'https://example-.com', 'https://example.com:', 'https://example.com:0', 'https://example.com:65536', 'https://example.com:abc', 'http://999.1.1.1', 'http://127.1', 'http://[:::1]', 'http://[::1', 'http://[1:2:3]', 'http://[1::2::3]', 'https://example.com/a_(b', 'https://example.com/a)']) assert.equal(safeWebUrl(input), '', JSON.stringify(input));
});

test('图片块与前后文字保持顺序，替代文字可读且不接受本地和危险图片', () => {
  const blocks = parseMarkdown('前文 ![**示意图**](https://example.com/a_(b).png "标题") 后文\n\n![单图](https://example.com/b.png)');
  assert.deepEqual(blocks.map(block => block.kind), ['paragraph', 'image', 'paragraph', 'image']);
  assert.equal(text(blocks[0]), '前文 ');
  assert.equal(blocks[1].src, 'https://example.com/a_(b).png');
  assert.equal(blocks[1].alt, '示意图');
  assert.equal(text(blocks[2]), ' 后文');
  assert.equal(blocks[3].alt, '单图');
  for (const input of ['![本地](/tmp/a.png)', '![危险](data:image/png;base64,abc)', '![未完成](https://example.com/a']) {
    assert.equal(parseMarkdown(input)[0].kind, 'paragraph');
    assert.equal(text(parseMarkdown(input)[0]), input);
    assert.equal(links(input).length, 0);
  }
});

test('列表图片的标记和层级仍然初始化并继承，重复图片不被缓存替换', () => {
  const blocks = parseMarkdown('- 父项\n  - ![图](https://example.com/a)\n\n![图二](https://example.com/b)');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[1].marker, '-');
  assert.equal(blocks[1].depth, 1);
  assert.equal(blocks[2].src, 'https://example.com/b');
});

test('表格对齐分割、转义管道、代码管道、行内样式和链接均真实解析', () => {
  const blocks = parseMarkdown('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| **粗体** | `a|b` | [文档](https://example.com) |\n| 转义\\|管道 | ~~删除~~ | https://example.org。 |');
  assert.equal(blocks.length, 1);
  const table = blocks[0];
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.rows.map(row => row.cells.map(cellText)), [['左', '中', '右'], ['粗体', 'a|b', '文档'], ['转义|管道', '删除', 'https://example.org。']]);
  assert.equal(table.rows[1].cells[0][0].bold, true);
  assert.equal(table.rows[1].cells[1][0].code, true);
  assert.equal(table.rows[1].cells[1][0].href, '');
  assert.equal(table.rows[1].cells[2][0].href, 'https://example.com');
  assert.equal(table.rows[2].cells[1][0].strike, true);
});

test('表格可省外侧管道，缺列补空，多列截断，空单元格不丢失', () => {
  const table = parseMarkdown('甲 | 乙\n--- | ---\n一 | 二\n三 |\n四 | 五 | 六\n| | |')[0];
  assert.deepEqual(table.rows.map(row => row.cells.map(cellText)), [['甲', '乙'], ['一', '二'], ['三', ''], ['四', '五'], ['', '']]);
  for (const input of ['甲 | 乙\n-- | ---', '甲 | 乙\n--- | --- | ---', '甲 | 乙\n---x | ---']) assert.ok(parseMarkdown(input).every(block => block.kind !== 'table'));
});

test('引用与列表中的表格保留深度，表格结束后的普通段落继续解析', () => {
  const blocks = parseMarkdown('> 甲 | 乙\n> :--- | ---:\n> 一 | 二\n\n段落');
  assert.equal(blocks[0].kind, 'table');
  assert.equal(blocks[0].rows.length, 2);
  assert.equal(text(blocks[1]), '段落');
});

test('HTML 标签和属性仅输出文字，不产生脚本、图片或属性内链接', () => {
  const input = '<img src="https://example.com/a.png" onerror="alert(1)">\n<script>alert(1)</script>\n<a href="javascript:alert(1)">文字</a>\n<!-- 注释 -->';
  const blocks = parseMarkdown(input);
  assert.equal(blocks.map(text).join('\n'), input);
  assert.ok(blocks.every(block => block.kind === 'paragraph'));
  assert.equal(links(input).length, 0);
  for (const html of ['<a title="> https://example.com">原文</a>', '<!-- > https://example.com -->', '<img\n src="https://example.com">']) {
    assert.equal(links(html).length, 0, html);
    assert.equal(parseMarkdown(html).map(text).join('\n'), html);
  }
});

test('全部流式前缀保持接口完整，代码及未完成图片不会出现可点击 URL', () => {
  for (const input of ['```js\nhttps://example.com/a\n```', '![图片](https://example.com/a_(b).png)', '`https://example.com/a`']) {
    for (let end = 1; end <= input.length; end++) {
      const blocks = parseMarkdown(input.slice(0, end));
      for (const block of blocks) {
        assert.ok(block.id.length > 0);
        assert.ok(block.depth >= 0);
        assert.ok(block.runs.every(run => run.href === ''));
      }
    }
  }
});

test('正常长文本及恶意未配对标记没有灾难回溯或栈溢出', { timeout: 15000 }, () => {
  const start = performance.now();
  const paragraph = '普通文字 **粗体 *嵌套***、[链接](https://example.com/a_(b)) 和 `代码`。\n'.repeat(3500);
  const result = parseMarkdown(paragraph);
  assert.equal(result.length, 1);
  assert.equal(result[0].runs.filter(run => run.href).length, 3500);
  const malformed = `${'['.repeat(30000)}未完成${')'.repeat(30000)}`;
  assert.equal(text(parseMarkdown(malformed)[0]), malformed);
  const delimiters = '*a '.repeat(30000);
  assert.equal(text(parseMarkdown(delimiters)[0]), delimiters.trimEnd());
  const brackets = `${'['.repeat(500)}文字${'](https://example.com)'.repeat(500)}`;
  assert.ok(parseMarkdown(brackets).length > 0);
  assert.ok(performance.now() - start < 12000, '大段正文应在合理时间内完成');
});
