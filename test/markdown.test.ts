import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownTitle, renderInline, renderMarkdown } from '../src/shared/markdown.ts';

test('renderMarkdown covers the blocks notes use and escapes HTML', () => {
  const md = `# Title <b>
Some *emphasis* and **strong** text with \`code\` and a [link](https://x.test) and https://auto.test/p.

- one
- [ ] todo
- [x] done

1. first
2. second

> quoted *text*

\`\`\`js
alert("<x>")
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

---`;
  const html = renderMarkdown(md);
  assert.ok(html.includes('<h1>Title &lt;b&gt;</h1>'));
  assert.ok(html.includes('<em>emphasis</em>') && html.includes('<strong>strong</strong>') && html.includes('<code>code</code>'));
  assert.ok(html.includes('<a href="https://x.test">link</a>'));
  assert.ok(html.includes('<a href="https://auto.test/p">https://auto.test/p</a>'));
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled> todo</li>'));
  assert.ok(html.includes('<li class="task done"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
  assert.ok(html.includes('<blockquote><p>quoted <em>text</em></p></blockquote>'));
  assert.ok(html.includes('<pre><code class="lang-js">alert(&quot;&lt;x&gt;&quot;)</code></pre>'));
  assert.ok(html.includes('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(!html.includes('<b>'));
});

test('unsafe links are neutralised and titles extracted', () => {
  assert.equal(renderInline('[x](javascript:void%200)'), '<a href="#">x</a>');
  assert.equal(renderInline('<script>'), '&lt;script&gt;');
  assert.equal(markdownTitle('\n\n## My **notes**\nmore'), 'My notes');
});
