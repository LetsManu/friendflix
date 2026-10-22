-- SPDX-FileCopyrightText: 2026 Manuel Weißböck
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Tests for the pure helpers in layout.lua; run with: lua5.4 desktop/player/test/layout_test.lua
local here = (arg and arg[0] or ''):match('^(.*)[/\\]test[/\\][^/\\]*$') or '.'
package.path = here .. '/?.lua;' .. package.path
local L = require('layout')

local function test_fmt_time()
  assert(L.fmt_time(0) == '0:00')
  assert(L.fmt_time(5) == '0:05')
  assert(L.fmt_time(123) == '2:03')
  assert(L.fmt_time(599.9) == '9:59')
  assert(L.fmt_time(3600) == '1:00:00')
  assert(L.fmt_time(3723) == '1:02:03')
  assert(L.fmt_time(36000 + 61) == '10:01:01')
  assert(L.fmt_time(-4) == '0:00')
  assert(L.fmt_time(nil) == '0:00')
end

local function test_seek_to_time()
  assert(L.seek_to_time(100, 100, 400, 1000) == 0)
  assert(L.seek_to_time(300, 100, 400, 1000) == 500)
  assert(L.seek_to_time(500, 100, 400, 1000) == 1000)
  assert(L.seek_to_time(0, 100, 400, 1000) == 0, 'left of the bar clamps to 0')
  assert(L.seek_to_time(9999, 100, 400, 1000) == 1000, 'right of the bar clamps to duration')
  assert(L.seek_to_time(200, 100, 0, 1000) == 0, 'zero width')
  assert(L.seek_to_time(200, 100, 400, 0) == 0, 'zero duration')
  assert(L.seek_to_time(200, 100, 400, nil) == 0, 'unknown duration')
end

local function test_chapter_marks()
  local ch = { { t = 0, name = 'a' }, { t = 250, name = 'b' }, { t = 500, name = 'c' }, { t = 2000, name = 'late' }, { t = -5, name = 'neg' } }
  local m = L.chapter_marks(ch, 100, 400, 1000)
  assert(#m == 2, 'start (t=0), out-of-range and negative chapters are skipped, got ' .. #m)
  assert(m[1] == 200 and m[2] == 300)
  assert(#L.chapter_marks({}, 0, 100, 10) == 0)
  assert(#L.chapter_marks(nil, 0, 100, 10) == 0)
  assert(#L.chapter_marks(ch, 0, 100, 0) == 0, 'no duration, no marks')
end

local function test_should_hide()
  assert(L.should_hide(10, 8, false) == false, '2 s after movement')
  assert(L.should_hide(10.99, 8, false) == false, 'just under 3 s')
  assert(L.should_hide(11, 8, false) == true, 'exactly 3 s')
  assert(L.should_hide(20, 8, false) == true)
  assert(L.should_hide(20, 8, true) == false, 'paused stays shown')
end

local function test_idiv_num()
  assert(L.idiv(7, 2) == 3 and L.idiv(-7, 2) == -4 and L.idiv(8, 2) == 4)
  assert(L.num(nil) == 0 and L.num('x') == 0 and L.num('5') == 5 and L.num({}) == 0 and L.num(3.5) == 3.5)
  assert(L.num(0/0) == 0 and L.num(math.huge) == 0, 'nan and inf are not numbers here')
end

local function test_clip_utf8()
  assert(L.clip('abc', 5) == 'abc')
  assert(L.clip('abcdef', 4) == 'abc…')
  local jp = '進撃の巨人 第一話 始まり'
  local c = L.clip(jp, 6) -- characters, not bytes
  assert(c == '進撃の巨人…', c)
  assert(L.clip(jp, 100) == jp)
  assert(L.clip(nil, 4) == '')
  assert(L.utf8_len(jp) == 13 and L.utf8_len('abc') == 3)
end

local function test_esc()
  assert(L.esc('a{b}c') == 'a(b)c')
  assert(L.esc('a\\Nb') == 'a\\\u{2060}Nb', 'backslash gets U+2060 after it')
  assert(L.esc('x\ny') == 'x y')
  assert(L.esc(nil) == '')
end

local function test_list()
  local r = L.list({ { t = 1 }, 'str', 5, { t = 2 }, false })
  assert(#r == 2 and r[2].t == 2, 'only table entries survive')
  assert(#L.list(nil) == 0 and #L.list('x') == 0)
end

test_idiv_num()
test_clip_utf8()
test_esc()
test_list()
test_fmt_time()
test_seek_to_time()
test_chapter_marks()
test_should_hide()
print('layout_test: ok')
