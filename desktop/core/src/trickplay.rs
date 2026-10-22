// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
//! Trickplay frame maths, tile cropping and the sheet cache.
use crate::model::TrickplayInfo;
use lru::LruCache;
use std::num::NonZeroUsize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub sheet: u32,
    pub x: u32,
    pub y: u32,
}

pub fn frame(t_ms: u64, tp: &TrickplayInfo) -> Frame {
    let last = (tp.count - 1).max(0) as u64;
    let idx = (t_ms / tp.interval_ms.max(1) as u64).min(last);
    let cols = tp.tile_width.max(1) as u64;
    let per = cols * tp.tile_height.max(1) as u64;
    let within = idx % per;
    let px = |v: u64, size: i32| (v * size.max(0) as u64).min(u32::MAX as u64) as u32;
    Frame {
        sheet: (idx / per).min(u32::MAX as u64) as u32,
        x: px(within % cols, tp.width),
        y: px(within / cols, tp.height),
    }
}

pub fn sheet_url(tp: &TrickplayInfo, sheet: u32) -> String {
    tp.url.replace("{n}", &sheet.to_string())
}

pub fn tile_bgra(jpeg: &[u8], f: &Frame, w: u32, h: u32) -> Option<Vec<u8>> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SHEET_SIDE);
    limits.max_image_height = Some(MAX_SHEET_SIDE);
    limits.max_alloc = Some(MAX_SHEET_ALLOC);
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(jpeg), image::ImageFormat::Jpeg);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let right = f.x.checked_add(w)?;
    let bottom = f.y.checked_add(h)?;
    if w == 0 || h == 0 || right > img.width() || bottom > img.height() {
        return None;
    }
    let mut out = img.crop_imm(f.x, f.y, w, h).to_rgba8().into_raw();
    for px in out.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    Some(out)
}

/// decode limits for a sheet from the network
const MAX_SHEET_SIDE: u32 = 8192;
const MAX_SHEET_ALLOC: u64 = 256 * 1024 * 1024;
const MAX_SHEETS: usize = 8;

pub struct SheetCache {
    sheets: LruCache<u32, Vec<u8>>,
}

impl Default for SheetCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SheetCache {
    pub fn new() -> Self {
        SheetCache {
            sheets: LruCache::new(NonZeroUsize::new(MAX_SHEETS).unwrap()),
        }
    }

    pub fn get_or_fetch(
        &mut self,
        sheet: u32,
        fetch: impl FnOnce() -> Option<Vec<u8>>,
    ) -> Option<&[u8]> {
        if !self.sheets.contains(&sheet) {
            let bytes = fetch()?;
            self.sheets.put(sheet, bytes);
        }
        self.sheets.get(&sheet).map(Vec::as_slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    fn tp() -> TrickplayInfo {
        // 4 x 3 tiles = 12 per sheet, 30 frames in 3 sheets, 10 s apart
        TrickplayInfo {
            width: 320,
            height: 180,
            tile_width: 4,
            tile_height: 3,
            count: 30,
            interval_ms: 10_000,
            url: "/trick/{n}.jpg".into(),
        }
    }

    #[test]
    fn frame_first_last_boundary_clamp() {
        let t = tp();
        assert_eq!(
            frame(0, &t),
            Frame {
                sheet: 0,
                x: 0,
                y: 0
            }
        );
        assert_eq!(
            frame(9_999, &t),
            Frame {
                sheet: 0,
                x: 0,
                y: 0
            }
        );
        assert_eq!(
            frame(10_000, &t),
            Frame {
                sheet: 0,
                x: 320,
                y: 0
            }
        );
        // idx 5 = row 1, col 1
        assert_eq!(
            frame(50_000, &t),
            Frame {
                sheet: 0,
                x: 320,
                y: 180
            }
        );
        // idx 11 = last of sheet 0
        assert_eq!(
            frame(110_000, &t),
            Frame {
                sheet: 0,
                x: 960,
                y: 360
            }
        );
        // idx 12 = per: first tile of sheet 1
        assert_eq!(
            frame(120_000, &t),
            Frame {
                sheet: 1,
                x: 0,
                y: 0
            }
        );
        // last frame idx 29 = sheet 2, within 5
        assert_eq!(
            frame(290_000, &t),
            Frame {
                sheet: 2,
                x: 320,
                y: 180
            }
        );
        // past the end clamps to count - 1
        assert_eq!(
            frame(10_000_000, &t),
            Frame {
                sheet: 2,
                x: 320,
                y: 180
            }
        );
        assert_eq!(sheet_url(&t, 2), "/trick/2.jpg");
    }

    #[test]
    fn tile_bgra_size_and_pixel() {
        // 2 x 2 tiles of 16 x 16: red, green, blue, yellow
        let colors: [[u8; 3]; 4] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
        let mut rgb = vec![0u8; 32 * 32 * 3];
        for y in 0..32usize {
            for x in 0..32usize {
                let c = colors[(y / 16) * 2 + x / 16];
                rgb[(y * 32 + x) * 3..][..3].copy_from_slice(&c);
            }
        }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 95)
            .write_image(&rgb, 32, 32, ExtendedColorType::Rgb8)
            .unwrap();
        let t = TrickplayInfo {
            width: 16,
            height: 16,
            tile_width: 2,
            tile_height: 2,
            count: 4,
            interval_ms: 1000,
            url: String::new(),
        };
        let f = frame(3_000, &t);
        let out = tile_bgra(&jpeg, &f, 16, 16).unwrap();
        assert_eq!(out.len(), 16 * 16 * 4);
        let near = |a: u8, b: u8| (a as i16 - b as i16).abs() <= 8;
        // tile 3 is yellow: B=0, G=255, R=255, A=255
        assert!(near(out[0], 0) && near(out[1], 255) && near(out[2], 255) && out[3] == 255);
        // tile 2 is blue: stored BGRA = 255, 0, 0
        let b = tile_bgra(&jpeg, &frame(2_000, &t), 16, 16).unwrap();
        assert!(near(b[0], 255) && near(b[1], 0) && near(b[2], 0));
        // outside the sheet or not a JPEG
        assert!(tile_bgra(
            &jpeg,
            &Frame {
                sheet: 0,
                x: 24,
                y: 0
            },
            16,
            16
        )
        .is_none());
        assert!(tile_bgra(b"nope", &f, 16, 16).is_none());
    }

    #[test]
    fn frame_huge_values_do_not_panic() {
        let t = TrickplayInfo {
            width: i32::MAX,
            height: i32::MAX,
            tile_width: i32::MAX,
            tile_height: i32::MAX,
            count: i32::MAX,
            interval_ms: 1,
            url: String::new(),
        };
        let _ = frame(u64::MAX, &t);
        let _ = frame(1 << 40, &t);
    }

    #[test]
    fn tile_bgra_refuses_oversized_sheet() {
        let rgb = vec![0u8; 9000 * 3];
        let mut jpeg = Vec::new();
        JpegEncoder::new(&mut jpeg)
            .write_image(&rgb, 9000, 1, ExtendedColorType::Rgb8)
            .unwrap();
        assert!(tile_bgra(
            &jpeg,
            &Frame {
                sheet: 0,
                x: 0,
                y: 0
            },
            16,
            1
        )
        .is_none());
    }

    #[test]
    fn cache_evicts_after_8() {
        let mut c = SheetCache::new();
        let mut fetches = 0;
        for n in 0..9u32 {
            let got = c.get_or_fetch(n, || {
                fetches += 1;
                Some(vec![n as u8])
            });
            assert_eq!(got, Some(&[n as u8][..]));
        }
        assert_eq!(fetches, 9);
        // 1..=8 are cached, 0 was evicted
        assert!(c.get_or_fetch(8, || panic!("cached")).is_some());
        assert!(c.get_or_fetch(1, || panic!("cached")).is_some());
        let mut again = false;
        c.get_or_fetch(0, || {
            again = true;
            Some(vec![0])
        });
        assert!(again);
        // a failed fetch is not cached
        assert!(c.get_or_fetch(99, || None).is_none());
        assert!(c.get_or_fetch(99, || Some(vec![1])).is_some());
    }
}
