'use strict';

// Claude Code tự ngắt dòng theo độ rộng pane lúc in (vd 52 cột trên điện thoại), tmux -J không nối lại được.
// Nối các dòng tiếp nối vào dòng trước: cùng thụt lề với phần chữ của đoạn, không mở đầu bằng dấu đầu dòng,
// và dòng trước đã gần chạm mép (chữ đầu của dòng sau không vừa chỗ trống còn lại).
// Chỉ nối văn xuôi; lệnh và kết quả công cụ (⏺ Bash(…), ⎿ …) bị cắt cả giữa chữ nên để nguyên.

// Ký hiệu mở đầu một khối mới của Claude/markdown, kèm khoảng trắng phía sau.
const MARKER = /^(?:[⏺⎿❯✻✶✳✢]\s*|(?:[-*•·>]|\d{1,3}[.)])\s+|[│╭╰├└┌┐┘─━┃]+\s*)/u;
const COMBINING = /\p{M}/u;
const WINDOW = 15;

function width(s) {
  let n = 0;
  for (const ch of s) if (!COMBINING.test(ch)) n++;
  return n;
}

const indentOf = (s) => s.length - s.trimStart().length;

function unwrap(text) {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const widths = lines.map(width);
  // Độ rộng lúc in xấp xỉ bằng dòng dài nhất quanh đó (độ rộng pane đổi theo thời gian).
  const localMax = (i) => Math.max(...widths.slice(Math.max(0, i - WINDOW), i + WINDOW + 1));
  const out = [];
  let para = null; // thụt lề của dòng tiếp nối trong đoạn văn đang xét
  lines.forEach((line, i) => {
    const content = line.trimStart();
    const indent = indentOf(line);
    if (para && content && i > 0 && widths[i - 1] && indent === para && !MARKER.test(content)) {
      const max = localMax(i);
      const prev = widths[i - 1];
      const first = width(content.split(/\s/, 1)[0]);
      if (max >= 30 && prev + 1 + first > max) {
        out[out.length - 1] += ` ${content}`;
        return;
      }
    }
    out.push(line);
    if (!content) {
      para = null;
      return;
    }
    const m = content.match(MARKER);
    if (m && (/^⎿/u.test(m[0]) || /^⏺\s*[\w-]+\(/u.test(content))) para = 'tool';
    else if (!m && para === 'tool') return;
    else para = indent + (m ? width(m[0]) : 0);
    if (para !== 'tool' && para < 2) para = null;
  });
  return out.join('\n');
}

module.exports = { unwrap };
