//! Executable icons as `data:image/png;base64,…` URLs (Windows only).

/// Minimal RFC 4648 base64 encoder (avoids a dependency for one call site).
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Encodes RGBA pixels as PNG.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().ok()?;
        w.write_image_data(rgba).ok()?;
    }
    Some(out)
}

#[cfg(windows)]
pub fn icon_data_url(path: &str) -> Option<String> {
    win::extract(path).and_then(|(w, h, px)| encode_png(w, h, &px)).map(|png| format!("data:image/png;base64,{}", base64(&png)))
}

#[cfg(not(windows))]
pub fn icon_data_url(_path: &str) -> Option<String> {
    None
}

#[cfg(windows)]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// Returns (width, height, RGBA pixels) of the executable's small icon.
    pub fn extract(path: &str) -> Option<(u32, u32, Vec<u8>)> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut large = HICON::default();
        let n = unsafe { ExtractIconExW(PCWSTR(wide.as_ptr()), 0, Some(&mut large), None, 1) };
        if n == 0 || large.is_invalid() {
            return None;
        }
        let result = unsafe { to_rgba(large) };
        unsafe {
            let _ = DestroyIcon(large);
        }
        result
    }

    unsafe fn to_rgba(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut info = ICONINFO::default();
        GetIconInfo(icon, &mut info).ok()?;
        let color = info.hbmColor;
        let mask = info.hbmMask;
        let cleanup = || {
            if !color.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(color.0));
            }
            if !mask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(mask.0));
            }
        };
        if color.is_invalid() {
            cleanup();
            return None;
        }
        let mut bm = BITMAP::default();
        if GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some((&mut bm as *mut BITMAP).cast())) == 0 {
            cleanup();
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 || w > 256 || h > 256 {
            cleanup();
            return None;
        }
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        let lines = GetDIBits(dc, color, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
        // Legacy icons without alpha: derive it from the AND mask.
        let has_alpha = px.chunks(4).any(|c| c[3] != 0);
        if lines != 0 && !has_alpha && !mask.is_invalid() {
            let mut mpx = vec![0u8; (w * h * 4) as usize];
            let mut mbmi = bmi;
            if GetDIBits(dc, mask, 0, h as u32, Some(mpx.as_mut_ptr().cast()), &mut mbmi, DIB_RGB_COLORS) != 0 {
                for (p, m) in px.chunks_mut(4).zip(mpx.chunks(4)) {
                    p[3] = if m[0] == 0 { 255 } else { 0 };
                }
            } else {
                px.chunks_mut(4).for_each(|p| p[3] = 255);
            }
        }
        ReleaseDC(None, dc);
        cleanup();
        if lines == 0 {
            return None;
        }
        // BGRA -> RGBA
        px.chunks_mut(4).for_each(|p| p.swap(0, 2));
        Some((w as u32, h as u32, px))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn png_has_signature() {
        let png = encode_png(2, 2, &[255u8; 16]).unwrap();
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[cfg(windows)]
    #[test]
    fn extracts_icon_from_system_executable() {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let url = icon_data_url(&format!("{root}\\explorer.exe"));
        assert!(url.is_some_and(|u| u.starts_with("data:image/png;base64,")));
    }
}
