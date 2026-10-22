-- SPDX-FileCopyrightText: 2026 Manuel Weißböck
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FriendFlix mpv control skin. It only draws controls and reports button presses; all logic and network calls live in
-- the app core. State arrives as `script-message-to friendflix ff-state <json>`, actions leave as
-- `script-message ff-action <json>`. Load with: mpv --script=<path>/friendflix.lua
local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

-- layout.lua sits next to this script; mpv does not put the script directory on package.path
local function script_dir()
  local d = mp.get_script_directory and mp.get_script_directory()
  if d and d ~= '' then return d end
  local src = debug.getinfo(1, 'S').source
  return (src:sub(1, 1) == '@' and src:sub(2) or src):match('^(.*)[/\\][^/\\]*$') or '.'
end
package.path = script_dir() .. '/?.lua;' .. package.path
local layout = require 'layout'
local idiv, num, list, clip, esc = layout.idiv, layout.num, layout.list, layout.clip, layout.esc

-- hide mpv's own on-screen controller; this skin replaces it
mp.commandv('script-message', 'osc-visibility', 'never', 'no-osd')

-- colours (ASS is &HBBGGRR&)
local BG, ACCENT, WHITE, MUTED = '181410', '6D4FFF', 'FFFFFF', 'B8B8B8' -- #101418, #ff4f6d
local FONT = 'Segoe UI'
local SEEK_STEP = 10
local PREVIEW_ID = 7
local DBL_WINDOW_S = 0.35

local state = {
  title = '', chip = 'Original', chipReason = '', chapters = {}, skip = nil, next = nil,
  qualities = {}, audio = {}, subs = {}, reconnecting = false, askStillWatching = false,
}
local ui = {
  last_move = mp.get_time(), mx = -1, my = -1, menu = nil, dragging = false, hover_chip = false,
  preview = nil, preview_shown = false, dbl_until = 0, pause_timer = nil, last_preview_req = 0, last_data = nil,
}
local P = { pause = false, pos = 0, dur = 0, vol = 100, mute = false, fs = false, w = 1280, h = 720, mpv_chapters = {} }
local overlay = mp.create_osd_overlay('ass-events')
local hits = {}

local function send(a, extra)
  local msg = extra or {}
  msg.a = a
  mp.commandv('script-message', 'ff-action', utils.format_json(msg))
end


local function visible()
  if ui.menu or ui.dragging then return true end
  return not layout.should_hide(mp.get_time(), ui.last_move, P.pause)
end

-- ASS drawing helpers ---------------------------------------------------------------------------------------------
local ev
local function rect(x, y, w, h, color, alpha)
  ev[#ev + 1] = string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a&H%02X&\\p1}m %d %d l %d %d %d %d %d %d{\\p0}',
    color, alpha or 0, x, y, x + w, y, x + w, y + h, x, y + h)
end
local function text(x, y, an, size, color, str, bold)
  ev[#ev + 1] = string.format('{\\an%d\\pos(%d,%d)\\fn%s\\fs%d\\b%d\\bord0\\shad0\\1c&H%s&}%s',
    an, x, y, FONT, size, bold and 1 or 0, color, esc(str))
end
local function inside(h, x, y) return x >= h.x and x <= h.x + h.w and y >= h.y and y <= h.y + h.h end
local function hit(x, y, w, h, fn, tag) hits[#hits + 1] = { x = x, y = y, w = w, h = h, fn = fn, tag = tag } end

local function button(x, y, w, h, label, fn, o)
  o = o or {}
  local hot = inside({ x = x, y = y, w = w, h = h }, ui.mx, ui.my)
  if o.fill then rect(x, y, w, h, o.fill, 0) elseif hot then rect(x, y, w, h, WHITE, 0xE6) end
  text(x + idiv(w, 2), y + idiv(h, 2), 5, o.size or 22, o.color or WHITE, label, o.bold)
  hit(x, y, w, h, fn)
end

-- menus -----------------------------------------------------------------------------------------------------------
local function menu_items()
  local items = {}
  if ui.menu == 'chapters' then
    local list = #state.chapters > 0 and state.chapters or P.mpv_chapters
    for i, c in ipairs(list) do
      items[#items + 1] = { label = layout.fmt_time(num(c.t)) .. '  ' .. clip(c.name or ('Chapter ' .. i), 34),
        fn = function() mp.commandv('no-osd', 'seek', string.format('%.3f', num(c.t)), 'absolute+exact') end }
    end
  else
    local list = ({ audio = state.audio, subs = state.subs, quality = state.qualities })[ui.menu] or {}
    local act = ({ audio = 'audio', subs = 'sub', quality = 'quality' })[ui.menu]
    for _, o in ipairs(list) do
      items[#items + 1] = { label = clip(o.label, 40), current = o.current, fn = function() send(act, { id = o.id }) end }
    end
  end
  return items
end

local function draw_menu(s, anchor_x, bottom)
  local items = menu_items()
  local titles = { chapters = 'Chapters', audio = 'Audio', subs = 'Subtitles', quality = 'Quality' }
  local iw, ih = math.floor(300 * s), math.floor(30 * s)
  local maxn = math.max(1, math.floor((bottom - 80 * s) / ih) - 1)
  local n = math.min(#items, maxn)
  local ph = (n + 1) * ih + 12
  local px = math.max(8, math.min(anchor_x - idiv(iw, 2), P.w - iw - 8))
  local py = bottom - ph
  rect(px, py, iw, ph, BG, 0x10)
  text(px + 14, py + 6 + idiv(ih, 2), 4, math.floor(16 * s), MUTED, titles[ui.menu], true)
  hit(px, py, iw, ph, function() end) -- swallow clicks on the panel
  if n == 0 then text(px + 14, py + 6 + ih + idiv(ih, 2), 4, math.floor(16 * s), MUTED, 'Nothing available') end
  for i = 1, n do
    local it = items[i]
    local y = py + 6 + i * ih
    local hot = inside({ x = px, y = y, w = iw, h = ih }, ui.mx, ui.my)
    if hot then rect(px, y, iw, ih, WHITE, 0xE6) end
    text(px + 14, y + idiv(ih, 2), 4, math.floor(16 * s), it.current and ACCENT or WHITE, (it.current and '● ' or '   ') .. it.label, it.current)
    hit(px, y, iw, ih, function() ui.menu = nil; it.fn() end)
  end
end

-- render ----------------------------------------------------------------------------------------------------------
local function render_body()
  ev, hits = {}, {}
  local W, H = P.w, P.h
  local s = math.max(0.6, H / 720)
  local show = visible()
  local pad = math.floor(16 * s)
  local bb_h = math.floor(104 * s)
  local bar_y = H - math.floor(70 * s)
  local bar_x0, bar_x1 = math.floor(80 * s), W - math.floor(80 * s)
  local bar_w = bar_x1 - bar_x0
  local bar = { x = bar_x0, y = bar_y - math.floor(10 * s), w = bar_w, h = math.floor(20 * s) }
  local dur = P.dur

  if show then
    -- top bar
    local th = math.floor(56 * s)
    rect(0, 0, W, th, BG, 0x40)
    button(pad, math.floor(8 * s), math.floor(40 * s), math.floor(40 * s), '←', function() send('back') end, { size = math.floor(26 * s) })
    text(pad + math.floor(56 * s), idiv(th, 2), 4, math.floor(20 * s), WHITE, clip(state.title, 80), true)
    local chip_w = math.floor((layout.utf8_len(state.chip) * 8 + 28) * s)
    local cx, cy, ch = W - pad - chip_w, math.floor(14 * s), math.floor(28 * s)
    local converted = state.chip ~= 'Original'
    rect(cx, cy, chip_w, ch, converted and ACCENT or '40342C', 0)
    text(cx + idiv(chip_w, 2), cy + idiv(ch, 2), 5, math.floor(14 * s), WHITE, state.chip, true)
    local chip_hot = inside({ x = cx, y = cy, w = chip_w, h = ch }, ui.mx, ui.my)
    if chip_hot and state.chipReason ~= '' then
      local rw = math.floor((layout.utf8_len(state.chipReason) * 7 + 24) * s)
      local rx = math.max(8, W - pad - rw)
      rect(rx, cy + ch + 6, rw, math.floor(28 * s), BG, 0x10)
      text(rx + idiv(rw, 2), cy + ch + 6 + math.floor(14 * s), 5, math.floor(14 * s), WHITE, state.chipReason)
    end

    -- bottom bar
    rect(0, H - bb_h, W, bb_h, BG, 0x40)
    text(pad, bar_y, 4, math.floor(15 * s), WHITE, layout.fmt_time(P.pos))
    text(W - pad, bar_y, 6, math.floor(15 * s), WHITE, '-' .. layout.fmt_time(math.max(0, dur - P.pos)))
    local th2 = math.floor(6 * s)
    rect(bar_x0, bar_y - idiv(th2, 2), bar_w, th2, '5A4A40', 0)
    local frac = dur > 0 and math.min(1, math.max(0, P.pos / dur)) or 0
    rect(bar_x0, bar_y - idiv(th2, 2), math.floor(bar_w * frac), th2, ACCENT, 0)
    local list = #state.chapters > 0 and state.chapters or P.mpv_chapters
    for _, mx in ipairs(layout.chapter_marks(list, bar_x0, bar_w, dur)) do
      rect(math.floor(mx) - 1, bar_y - math.floor(7 * s), 3, math.floor(14 * s), WHITE, 0x30)
    end
    local kx = bar_x0 + math.floor(bar_w * frac)
    rect(kx - math.floor(6 * s), bar_y - math.floor(6 * s), math.floor(12 * s), math.floor(12 * s), ACCENT, 0)
    hit(bar.x, bar.y, bar.w, bar.h, nil, 'seek')

    -- hover time
    if dur > 0 and inside(bar, ui.mx, ui.my) and not ui.menu then
      local t = layout.seek_to_time(ui.mx, bar_x0, bar_w, dur)
      text(ui.mx, bar_y - math.floor(22 * s), 2, math.floor(14 * s), WHITE, layout.fmt_time(t), true)
    end

    -- buttons
    local by, bs = H - math.floor(46 * s), math.floor(40 * s)
    local fs = math.floor(22 * s)
    local x = pad
    button(x, by, bs, bs, P.pause and '▶' or '⏸', function() mp.commandv('no-osd', 'cycle', 'pause') end, { size = fs }); x = x + bs
    button(x, by, bs, bs, '−10', function() mp.commandv('no-osd', 'seek', -SEEK_STEP) end, { size = math.floor(14 * s), bold = true }); x = x + bs
    button(x, by, bs, bs, '+10', function() mp.commandv('no-osd', 'seek', SEEK_STEP) end, { size = math.floor(14 * s), bold = true }); x = x + bs
    button(x, by, bs, bs, P.mute and '🔇' or '🔊', function() mp.commandv('no-osd', 'cycle', 'mute') end, { size = math.floor(18 * s) }); x = x + bs
    text(x, by + idiv(bs, 2), 4, math.floor(14 * s), MUTED, P.mute and 'muted' or (math.floor(P.vol) .. '%'))

    local rx = W - pad - bs
    local anchors = {}
    local function rbtn(label, fn, size, menu)
      button(rx, by, bs, bs, label, fn, { size = size or fs, bold = size ~= nil, fill = (menu and ui.menu == menu) and '40342C' or nil })
      if menu then anchors[menu] = rx + idiv(bs, 2) end
      rx = rx - bs
    end
    rbtn('⛶', function() mp.commandv('no-osd', 'cycle', 'fullscreen') end)
    rbtn('HD', function() ui.menu = ui.menu ~= 'quality' and 'quality' or nil end, math.floor(14 * s), 'quality')
    rbtn('CC', function() ui.menu = ui.menu ~= 'subs' and 'subs' or nil end, math.floor(14 * s), 'subs')
    rbtn('♪', function() ui.menu = ui.menu ~= 'audio' and 'audio' or nil end, fs, 'audio')
    rbtn('☰', function() ui.menu = ui.menu ~= 'chapters' and 'chapters' or nil end, fs, 'chapters')
    rbtn('⏭', function() if state.next then send('next') end end)
    if ui.menu then draw_menu(s, anchors[ui.menu] or (W - 100), H - bb_h - 6) end
  end

  -- cards stay visible while the controls are hidden
  local cy = H - (show and bb_h or 0) - math.floor(16 * s)
  local cw = math.floor(320 * s)
  local cx = W - pad - cw
  if state.next then
    local chh = math.floor(96 * s)
    cy = cy - chh
    rect(cx, cy, cw, chh, BG, 0x10)
    rect(cx, cy, math.floor(4 * s), chh, ACCENT, 0)
    text(cx + math.floor(16 * s), cy + math.floor(18 * s), 4, math.floor(13 * s), MUTED, 'Next episode', true)
    text(cx + math.floor(16 * s), cy + math.floor(40 * s), 4, math.floor(16 * s), WHITE, clip(state.next.title, 34), true)
    if state.next.inS then
      text(cx + math.floor(16 * s), cy + math.floor(62 * s), 4, math.floor(13 * s), MUTED, 'Starting in ' .. math.max(0, math.ceil(state.next.inS)) .. ' s')
    end
    local bw, bh = math.floor(96 * s), math.floor(28 * s)
    button(cx + cw - 2 * bw - 16, cy + chh - bh - 8, bw, bh, 'Cancel', function() send('cancelNext') end, { size = math.floor(14 * s), fill = '40342C' })
    button(cx + cw - bw - 8, cy + chh - bh - 8, bw, bh, 'Play now', function() send('next') end, { size = math.floor(14 * s), fill = ACCENT, bold = true })
    cy = cy - math.floor(12 * s)
  end
  if state.skip then
    local bw, bh = math.floor(180 * s), math.floor(40 * s)
    cy = cy - bh
    button(W - pad - bw, cy, bw, bh, clip(state.skip.label, 24), function() send('skip') end,
      { size = math.floor(16 * s), fill = ACCENT, bold = true })
  end
  if state.askStillWatching then
    local sw, sh = math.floor(380 * s), math.floor(130 * s)
    local sx, sy = idiv((W - sw), 2), idiv((H - sh), 2)
    rect(0, 0, W, H, '000000', 0x80)
    hit(0, 0, W, H, function() end)
    rect(sx, sy, sw, sh, BG, 0x08)
    text(sx + idiv(sw, 2), sy + math.floor(42 * s), 5, math.floor(24 * s), WHITE, 'Still watching?', true)
    local bw, bh = math.floor(140 * s), math.floor(40 * s)
    button(sx + idiv((sw - bw), 2), sy + sh - bh - math.floor(18 * s), bw, bh, 'Yes', function() send('stillYes') end,
      { size = math.floor(18 * s), fill = ACCENT, bold = true })
  end
  if state.reconnecting then
    local rw, rh = math.floor(220 * s), math.floor(34 * s)
    rect(idiv((W - rw), 2), math.floor(70 * s), rw, rh, BG, 0x10)
    text(idiv(W, 2), math.floor(70 * s) + idiv(rh, 2), 5, math.floor(15 * s), WHITE, 'Reconnecting…', true)
  end

  local data = table.concat(ev, '\n')
  if data ~= ui.last_data then
    ui.last_data = data
    overlay.res_x, overlay.res_y = W, H
    overlay.data = data
    overlay:update()
  end
  -- the preview thumbnail only belongs to a visible seek bar
  if ui.preview_shown and not (show and inside(bar, ui.mx, ui.my)) then
    mp.commandv('overlay-remove', tostring(PREVIEW_ID))
    ui.preview_shown = false
  end
  ui.bar = bar
  ui.bar_x0, ui.bar_w = bar_x0, bar_w
end

local function render()
  local ok, err = pcall(render_body)
  if not ok then msg.warn('render failed: ' .. tostring(err)) end
end

-- input -----------------------------------------------------------------------------------------------------------
local function refresh_mouse()
  local m = mp.get_mouse_pos()
  if m then ui.mx, ui.my = m.x, m.y end
end

local function hit_at(x, y)
  for i = #hits, 1, -1 do
    if inside(hits[i], x, y) then return hits[i] end
  end
end

local function seek_from_mouse(exact)
  local t = layout.seek_to_time(ui.mx, ui.bar_x0, ui.bar_w, P.dur)
  mp.commandv('no-osd', 'seek', string.format('%.3f', t), exact and 'absolute+exact' or 'absolute+keyframes')
end

local function request_preview()
  if P.dur <= 0 or not ui.bar or not inside(ui.bar, ui.mx, ui.my) then return end
  local now = mp.get_time()
  if now - ui.last_preview_req < 0.08 then return end
  ui.last_preview_req = now
  local t = layout.seek_to_time(ui.mx, ui.bar_x0, ui.bar_w, P.dur)
  send('preview', { tMs = math.floor(t * 1000) })
end

local function on_move()
  refresh_mouse()
  ui.last_move = mp.get_time()
  if ui.dragging then seek_from_mouse(false) else request_preview() end
  render()
end

local function on_click(e)
  refresh_mouse()
  ui.last_move = mp.get_time()
  if e.event == 'down' then
    if not visible() and not state.skip and not state.next and not state.askStillWatching then return end
    local h = hit_at(ui.mx, ui.my)
    if h and h.tag == 'seek' and not ui.menu then
      ui.dragging = true
      seek_from_mouse(false)
    elseif h and h.fn then
      h.fn()
    elseif ui.menu then
      ui.menu = nil
    elseif mp.get_time() >= ui.dbl_until then
      -- wait out the double-click window: a double-click is fullscreen and must not leave the video paused
      if ui.pause_timer then ui.pause_timer:kill() end
      ui.pause_timer = mp.add_timeout(DBL_WINDOW_S, function()
        ui.pause_timer = nil
        mp.commandv('no-osd', 'cycle', 'pause')
      end)
    end
  elseif e.event == 'up' and ui.dragging then
    ui.dragging = false
    seek_from_mouse(true)
  end
  render()
end

local function touch() ui.last_move = mp.get_time() end
local function key(name, fn, opts) mp.add_forced_key_binding(name, 'ff-' .. name, function(e) fn(e); touch(); render() end, opts) end

mp.add_forced_key_binding('mouse_move', 'ff-mouse-move', on_move)
mp.add_forced_key_binding('MBTN_LEFT', 'ff-click', on_click, { complex = true })
mp.add_forced_key_binding('MBTN_LEFT_DBL', 'ff-dblclick', function()
  refresh_mouse()
  ui.dbl_until = mp.get_time() + DBL_WINDOW_S
  if ui.pause_timer then ui.pause_timer:kill(); ui.pause_timer = nil end
  if not hit_at(ui.mx, ui.my) then mp.commandv('no-osd', 'cycle', 'fullscreen') end
end)
key('SPACE', function() mp.commandv('no-osd', 'cycle', 'pause') end, { repeatable = false })
key('k', function() mp.commandv('no-osd', 'cycle', 'pause') end)
key('LEFT', function() mp.commandv('no-osd', 'seek', -SEEK_STEP) end, { repeatable = true })
key('RIGHT', function() mp.commandv('no-osd', 'seek', SEEK_STEP) end, { repeatable = true })
key('UP', function() mp.commandv('no-osd', 'add', 'volume', 5) end, { repeatable = true })
key('DOWN', function() mp.commandv('no-osd', 'add', 'volume', -5) end, { repeatable = true })
key('m', function() mp.commandv('no-osd', 'cycle', 'mute') end)
key('f', function() mp.commandv('no-osd', 'cycle', 'fullscreen') end)
key('n', function() if state.next then send('next') end end)
key('c', function() mp.commandv('no-osd', 'cycle', 'sub-visibility') end)
key('ESC', function()
  if ui.menu then ui.menu = nil
  elseif P.fs then mp.set_property('fullscreen', 'no')
  else send('back') end
end)

-- state from the app core -----------------------------------------------------------------------------------------
mp.register_script_message('ff-state', function(json)
  local d = utils.parse_json(json)
  if type(d) ~= 'table' then return end
  state.title = tostring(d.title or '')
  state.chip = tostring(d.chip or 'Original')
  state.chipReason = tostring(d.chipReason or '')
  state.chapters = list(d.chapters)
  for _, c in ipairs(state.chapters) do c.t = num(c.t) end
  table.sort(state.chapters, function(a, b) return a.t < b.t end)
  state.skip = type(d.skip) == 'table' and { label = tostring(d.skip.label or 'Skip'), endS = num(d.skip.endS) } or nil
  state.next = type(d.next) == 'table' and { title = tostring(d.next.title or ''), inS = d.next.inS ~= nil and num(d.next.inS) or nil } or nil
  state.qualities, state.audio, state.subs = list(d.qualities), list(d.audio), list(d.subs)
  for _, o in ipairs(state.qualities) do o.label = tostring(o.label or '') end
  for _, o in ipairs(state.audio) do o.label = tostring(o.label or '') end
  for _, o in ipairs(state.subs) do o.label = tostring(o.label or '') end
  state.reconnecting = d.reconnecting == true
  state.askStillWatching = d.askStillWatching == true
  render()
end)

-- ff-preview {path, w, h}: raw BGRA tile, drawn above the cursor x
mp.register_script_message('ff-preview', function(json)
  local d = utils.parse_json(json)
  if type(d) ~= 'table' or type(d.path) ~= 'string' or not ui.bar then return end
  d.w, d.h = math.floor(num(d.w)), math.floor(num(d.h))
  if d.w <= 0 or d.h <= 0 then return end
  refresh_mouse()
  if not visible() or not inside(ui.bar, ui.mx, ui.my) then return end -- cursor left the seek bar meanwhile
  local x = math.max(0, math.min(ui.mx - idiv(d.w, 2), P.w - d.w))
  local y = math.max(0, ui.bar.y - d.h - math.floor(40 * math.max(0.6, P.h / 720)))
  mp.commandv('overlay-add', tostring(PREVIEW_ID), tostring(math.floor(x)), tostring(math.floor(y)), d.path, '0', 'bgra',
    tostring(d.w), tostring(d.h), tostring(d.w * 4))
  ui.preview_shown = true
end)
mp.register_script_message('ff-preview-hide', function()
  mp.commandv('overlay-remove', tostring(PREVIEW_ID))
  ui.preview_shown = false
end)

-- mpv properties --------------------------------------------------------------------------------------------------
mp.observe_property('pause', 'bool', function(_, v) P.pause = v == true; touch() end)
mp.observe_property('time-pos', 'number', function(_, v) P.pos = v or 0 end)
mp.observe_property('duration', 'number', function(_, v) P.dur = v or 0 end)
mp.observe_property('volume', 'number', function(_, v) P.vol = v or 0 end)
mp.observe_property('mute', 'bool', function(_, v) P.mute = v == true end)
mp.observe_property('fullscreen', 'bool', function(_, v) P.fs = v == true end)
mp.observe_property('chapter-list', 'native', function(_, v)
  P.mpv_chapters = list(v)
  for _, c in ipairs(P.mpv_chapters) do c.t = num(c.time); c.name = c.title end
end)
mp.observe_property('osd-dimensions', 'native', function(_, v)
  if type(v) == 'table' and (v.w or 0) > 0 and (v.h or 0) > 0 then P.w, P.h = v.w, v.h end
end)

mp.add_periodic_timer(0.25, render)
mp.register_event('shutdown', function() overlay:remove() end)
render()
