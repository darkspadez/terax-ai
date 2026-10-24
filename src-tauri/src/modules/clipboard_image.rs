//! Clipboard images for terminal programs (the Kitty clipboard protocol),
//! as PNG both ways. They go through the clipboard plugin's long-lived
//! clipboard, the one text uses, so an image written here stays served on
//! X11 like text does. Reads run off the main thread: on Linux a read of
//! something this app owns would otherwise deadlock.

use std::io::Cursor;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits};
use tauri::ipc::{Request, Response};
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::ipc_body;

/// PNG bytes taken or given at once: as much as one Kitty clipboard write
/// carries. Reads larger than a Kitty answer serves are refused by the
/// webview (`terminalIntegration.ts`).
const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;
/// Largest side of an image written, against decompression bombs.
const MAX_SIDE: u32 = 16_384;
/// Decoded bytes an image written may take.
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;

/// RGBA pixels as PNG, compressed for speed: the program receiving it
/// recompresses if it cares.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    if out.len() > MAX_PNG_BYTES {
        return Err("the clipboard image is too large".into());
    }
    Ok(out)
}

/// A PNG as RGBA pixels, refusing images too large to hold.
fn decode_png(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("not a usable PNG: {error}"))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    Ok((image.into_raw(), width, height))
}

/// The clipboard's image as PNG; an empty body when it holds none.
#[tauri::command]
pub async fn clipboard_image_read(app: tauri::AppHandle) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // No image (text, or nothing) is an error from the clipboard.
        let Ok(image) = app.clipboard().read_image() else {
            return Ok(Response::new(Vec::new()));
        };
        encode_png(image.rgba(), image.width(), image.height()).map(Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Body: a PNG, which replaces the clipboard's contents.
#[tauri::command]
pub async fn clipboard_image_write(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<(), String> {
    let png = ipc_body::bytes_of(request.body(), MAX_PNG_BYTES, 0)?.into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let (rgba, width, height) = decode_png(&png)?;
        let image = tauri::image::Image::new_owned(rgba, width, height);
        app.clipboard()
            .write_image(&image)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_round_trip_through_png() {
        let rgba: Vec<u8> = (0..4 * 3 * 2).map(|i| (i * 7) as u8).collect();
        let png = encode_png(&rgba, 3, 2).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decode_png(&png).unwrap(), (rgba, 3, 2));
    }

    #[test]
    fn writes_refuse_what_is_not_a_reasonable_png() {
        assert!(decode_png(b"not a png").is_err());
        // A header claiming an image wider than the limit is refused before
        // any pixels are allocated.
        let wide = encode_png(&[0; 4], 1, 1).unwrap();
        let mut forged = wide.clone();
        // IHDR width (bytes 16..20), big-endian; the CRC no longer matches,
        // which the decoder may report first: either way it is refused.
        forged[16..20].copy_from_slice(&(MAX_SIDE + 1).to_be_bytes());
        assert!(decode_png(&forged).is_err());
    }
}
