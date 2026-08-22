/**
 * BulkyGen Offscreen Document — Image Processing Worker
 *
 * Runs inside a chrome.offscreen document (invisible page) that has access to
 * Canvas/OffscreenCanvas, createImageBitmap, etc. — APIs not available in the
 * MV3 service worker.
 *
 * Message protocol:
 *   REQUEST  → { action: 'processImage', id, dataUrl, watermark, jpegQuality }
 *   RESPONSE → { action: 'processImageResult', id, dataUrl, width, height, mimeType, error? }
 */
(function () {
    'use strict';

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action !== 'offscreenProcessImage') return false;

        processImage(message)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({
                success: false,
                error: err.message || 'Unknown offscreen processing error'
            }));

        return true; // async response
    });

    /**
     * Full image processing pipeline:
     *   1. Decode data URL → ImageBitmap (strips all EXIF metadata)
     *   2. Draw onto canvas at original resolution
     *   3. Optionally apply watermark
     *   4. Export as JPEG at requested quality
     *   5. Return as data URL with dimensions
     */
    async function processImage(msg) {
        const { dataUrl, watermark, jpegQuality = 0.90 } = msg;

        if (!dataUrl) throw new Error('No dataUrl provided');

        // ── Step 1 & 2: Decode (strips metadata) and JPEG encode ────────────────────
        const initialBlob = dataUrlToBlob(dataUrl);
        const bmp1 = await createImageBitmap(initialBlob);
        const quality = Math.max(0.1, Math.min(1.0, parseFloat(jpegQuality) || 0.90));
        
        const canvas1 = new OffscreenCanvas(bmp1.width, bmp1.height);
        const ctx1 = canvas1.getContext('2d');
        ctx1.drawImage(bmp1, 0, 0);
        bmp1.close();

        // Encode to JPEG to bake in the compression artifacts
        const jpegBlob = await canvas1.convertToBlob({ type: 'image/jpeg', quality });

        // ── Step 3: GPU Perturbation Filters ──────────────────────────────────────────
        const bmp2 = await createImageBitmap(jpegBlob);
        
        let filteredBmp = bmp2;
        if (globalThis.bulkygenGpuFilters && msg.processingProfile) {
            filteredBmp = await globalThis.bulkygenGpuFilters.applyFilters(bmp2, msg.processingProfile);
            bmp2.close();
        }

        // ── Step 4: Optional Watermark ─────────────────────────────────────────────
        const finalCanvas = new OffscreenCanvas(filteredBmp.width, filteredBmp.height);
        const finalCtx = finalCanvas.getContext('2d');
        finalCtx.drawImage(filteredBmp, 0, 0);
        filteredBmp.close();

        if (watermark && watermark.enabled) {
            await applyWatermark(finalCtx, finalCanvas.width, finalCanvas.height, watermark);
        }

        // ── Step 5: Final Export (requested format, compressed to fit maxSizeKB) ──
        const outFileType = normalizeFileType(msg.fileType) || 'image/jpeg';
        const maxSizeKB = (msg.maxSizeKB !== null && msg.maxSizeKB !== undefined && msg.maxSizeKB !== '' && isFinite(parseFloat(msg.maxSizeKB)) && parseFloat(msg.maxSizeKB) > 0)
            ? parseFloat(msg.maxSizeKB) : null;

        const { blob: outputBlob, canvas: outCanvas, quality: outQuality } =
            await encodeToTargetSize(finalCanvas, outFileType, maxSizeKB);

        // Convert back to data URL for transport to background script
        const outputDataUrl = await blobToDataUrl(outputBlob);

        return {
            success: true,
            dataUrl: outputDataUrl,
            width: outCanvas.width,
            height: outCanvas.height,
            mimeType: outFileType,
            quality: outQuality,
            size: outputBlob.size
        };
    }

    // ── Utility: map a user-facing file type ("PNG", "jpeg", "image/webp"...) ──
    // to a canvas-encodable mime type.
    function normalizeFileType(v) {
        if (!v) return null;
        const s = String(v).trim().toLowerCase().replace(/^image\//, '');
        if (s === 'jpg' || s === 'jpeg') return 'image/jpeg';
        if (s === 'png') return 'image/png';
        if (s === 'webp') return 'image/webp';
        return null;
    }

    /**
     * Encode a canvas to the requested mime type, compressed to fit under
     * maxSizeKB if given (null/0 = no size limit, just encode at best quality).
     *
     * - JPEG/WebP support a quality knob: binary-search it down to the largest
     *   quality that still fits the target size.
     * - PNG is lossless (no quality knob) — if it doesn't fit, and for
     *   JPEG/WebP that still don't fit even at the lowest quality, the image
     *   is progressively downscaled and re-encoded until it fits.
     *
     * @returns {Promise<{ blob: Blob, canvas: OffscreenCanvas, quality?: number }>}
     */
    async function encodeToTargetSize(sourceCanvas, mimeType, maxSizeKB) {
        const supportsQuality = mimeType === 'image/jpeg' || mimeType === 'image/webp';
        const maxBytes = maxSizeKB ? Math.floor(maxSizeKB * 1024) : null;

        // No size limit requested — encode once, at full quality, and done.
        if (!maxBytes) {
            const blob = supportsQuality
                ? await sourceCanvas.convertToBlob({ type: mimeType, quality: 1.0 })
                : await sourceCanvas.convertToBlob({ type: mimeType });
            return { blob, canvas: sourceCanvas, quality: supportsQuality ? 1.0 : undefined };
        }

        let workCanvas = sourceCanvas;
        // Track the smallest candidate produced across ALL passes so there is
        // always something valid to fall back to. Previously the loop reset
        // its only reference to the just-encoded blob to null right before
        // shrinking for the next pass, then exited the "for" loop after the
        // final shrink without ever re-encoding at that smaller size —
        // returning a null blob. That crashed processImage() outright (caught
        // upstream as a failure), which silently skipped watermarking, format
        // conversion, AND metadata for that image. PNG hit this constantly
        // (no quality knob to fall back on, and the GPU noise pass makes PNG
        // compress worse), which is why compression/watermark/format all
        // looked "broken" specifically on non-JPEG/WebP output.
        let smallestBlob = null;
        let smallestQuality = undefined;
        let smallestCanvas = workCanvas;

        for (let downscalePass = 0; downscalePass < 9; downscalePass++) {
            let candidateBlob;
            let candidateQuality;

            if (supportsQuality) {
                // Binary-search quality for the largest value that still fits.
                let lo = 0.05, hi = 1.0;
                let fitBlob = null, fitQuality;
                for (let i = 0; i < 8; i++) {
                    const mid = (lo + hi) / 2;
                    const candidate = await workCanvas.convertToBlob({ type: mimeType, quality: mid });
                    if (candidate.size <= maxBytes) {
                        fitBlob = candidate;
                        fitQuality = mid;
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                if (fitBlob) {
                    candidateBlob = fitBlob;
                    candidateQuality = fitQuality;
                } else {
                    // Doesn't fit even at the floor quality -- still keep it as
                    // this pass's candidate (may become the eventual fallback),
                    // and fall through to downscaling below.
                    candidateBlob = await workCanvas.convertToBlob({ type: mimeType, quality: 0.05 });
                    candidateQuality = 0.05;
                }
            } else {
                // PNG: no quality knob, just encode as-is.
                candidateBlob = await workCanvas.convertToBlob({ type: mimeType });
            }

            // Remember the smallest candidate seen so far, regardless of
            // whether it fits -- guarantees a non-null result even if the
            // target is never hit within the downscale budget.
            if (!smallestBlob || candidateBlob.size < smallestBlob.size) {
                smallestBlob = candidateBlob;
                smallestQuality = candidateQuality;
                smallestCanvas = workCanvas;
            }

            if (candidateBlob.size <= maxBytes) {
                return { blob: candidateBlob, canvas: workCanvas, quality: candidateQuality };
            }

            // Still too big -- shrink the canvas ~15% and try again.
            const newW = Math.max(1, Math.round(workCanvas.width * 0.85));
            const newH = Math.max(1, Math.round(workCanvas.height * 0.85));
            if (newW === workCanvas.width && newH === workCanvas.height) break; // can't shrink further
            const scaledCanvas = new OffscreenCanvas(newW, newH);
            scaledCanvas.getContext('2d').drawImage(workCanvas, 0, 0, newW, newH);
            workCanvas = scaledCanvas;
        }

        // Ran out of downscale passes without hitting the target -- return the
        // smallest candidate we ever actually produced (guaranteed non-null),
        // rather than crashing the whole pipeline over an unreachable target.
        console.warn(`BulkyGen: could not compress ${mimeType} under ${maxSizeKB}KB even after 9 downscale passes; returning the smallest result achieved (${Math.round(smallestBlob.size / 1024)}KB).`);
        return { blob: smallestBlob, canvas: smallestCanvas, quality: smallestQuality };
    }

    // ── Watermark rendering ──────────────────────────────────────────────────
    async function applyWatermark(ctx, canvasW, canvasH, opts) {
        const {
            text,
            logoUrl,
            opacity = 1.0,
            position = 'bottom-right',
            rotation = 0,
            font = '24px sans-serif',
            scale = 1.0,
            margin = 20
        } = opts;

        ctx.save();
        const parsedOpacity = parseFloat(opacity);
        ctx.globalAlpha = Math.max(0, Math.min(1, Number.isFinite(parsedOpacity) ? parsedOpacity : 1.0));

        // ── 5th layout: "banner" ────────────────────────────────────────────
        // A boxed website/credit line (white box, black border, black text)
        // with black horizontal rules running from the box out toward the
        // left/right edges. Totally different draw path from the plain
        // text-anchor watermark below, so it's handled and returned early.
        // Trigger with position = "banner-bottom" | "banner-top" | "banner-center".
        if (String(position).toLowerCase().startsWith('banner')) {
            const vAlign = String(position).toLowerCase().replace('banner-', '') || 'bottom';
            drawBannerWatermark(ctx, canvasW, canvasH, opts, ['top', 'center', 'bottom'].includes(vAlign) ? vAlign : 'bottom');
            ctx.restore();
            return;
        }

        // Calculate anchor position
        const { x, y, textAlign, textBaseline } = getAnchor(position, canvasW, canvasH, margin);

        // Apply rotation around the anchor point
        if (rotation) {
            ctx.translate(x, y);
            ctx.rotate((rotation * Math.PI) / 180);
            ctx.translate(-x, -y);
        }

        // Logo watermark
        if (logoUrl) {
            try {
                const logoBlob = dataUrlToBlob(logoUrl);
                const logoBmp = await createImageBitmap(logoBlob);
                const logoW = logoBmp.width * scale;
                const logoH = logoBmp.height * scale;
                const lx = textAlign === 'right' ? x - logoW : textAlign === 'center' ? x - logoW / 2 : x;
                const ly = textBaseline === 'bottom' ? y - logoH : textBaseline === 'middle' ? y - logoH / 2 : y;
                ctx.drawImage(logoBmp, lx, ly, logoW, logoH);
                logoBmp.close();
            } catch (e) {
                console.warn('Watermark logo failed:', e);
            }
        }

        // Text watermark
        if (text) {
            const scaledSize = Math.round(parseInt(font) * scale) || 24;
            const fontFamily = font.replace(/^\d+px\s*/, '') || 'sans-serif';
            ctx.font = `bold ${scaledSize}px ${fontFamily}`;
            ctx.textAlign = textAlign;
            ctx.textBaseline = textBaseline;

            // A soft shadow behind everything for a bit of extra depth
            ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;

            // Black outline drawn first — this is what keeps the text visible
            // on white/light backgrounds, where a plain white fill disappears.
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.lineWidth = Math.max(2, Math.round(scaledSize * 0.09));
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.strokeText(text, x, y);

            // White fill on top of the outline
            ctx.shadowColor = 'transparent'; // shadow already applied via the stroke pass
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillText(text, x, y);
        }

        ctx.restore();
    }

    /**
     * Draws the boxed "website credit" banner layout: a white box with a
     * black border and centered black text, plus thin black horizontal
     * rules running from the box out toward the left/right edges of the
     * image (stopping `margin` px short of each edge).
     *
     * All sizing (box padding, border width, rule thickness, corner
     * radius) is derived from the resolved font size, so no extra Supabase
     * columns are needed beyond the ones the watermark already supports:
     *   - text    → the label drawn inside the box (e.g. "© www.site.com")
     *   - font    → e.g. "20px Arial" — controls text AND box scale
     *   - scale   → additional multiplier on font size
     *   - margin  → distance from the box to the bottom/top edge, AND the
     *               distance the side rules stop short of the left/right edges
     *   - opacity → overall alpha (set opacity:1 to fully match a solid
     *               white/black banner like a printed photo credit)
     *   - cornerRadius (optional) → override the box's corner radius in px;
     *               omit to auto-scale with font size (~28% of font size)
     *
     * @param {string} vAlign — 'bottom' | 'top' | 'center'
     */
    function drawBannerWatermark(ctx, canvasW, canvasH, opts, vAlign) {
        const { text, font = '24px sans-serif', scale = 1.0, margin = 20, cornerRadius } = opts;
        if (!text) return; // nothing to draw — box+lines with no label doesn't make sense

        const fontSizePx = Math.max(8, Math.round((parseInt(font) || 24) * (parseFloat(scale) || 1.0)));
        const fontFamily = font.replace(/^\d+px\s*/, '') || 'Arial, sans-serif';
        ctx.font = `500 ${fontSizePx}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const textW = ctx.measureText(text).width;

        const padX = Math.round(fontSizePx * 0.75);
        const padY = Math.round(fontSizePx * 0.45);
        const boxW = textW + padX * 2;
        const boxH = fontSizePx + padY * 2;
        const borderWidth = Math.max(1, Math.round(fontSizePx * 0.06));
        const radius = Math.min(
            boxH / 2,
            Number.isFinite(parseFloat(cornerRadius)) ? parseFloat(cornerRadius) : Math.round(fontSizePx * 0.28)
        );

        const cx = canvasW / 2;
        const m = margin || 20;
        let boxY; // top of box
        if (vAlign === 'top') {
            boxY = m;
        } else if (vAlign === 'center') {
            boxY = (canvasH - boxH) / 2;
        } else {
            boxY = canvasH - m - boxH; // bottom (default)
        }
        const boxX = cx - boxW / 2;
        const lineY = boxY + boxH / 2;

        // Box: white fill, black border — rounded rect
        traceRoundedRect(ctx, boxX, boxY, boxW, boxH, radius);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = '#000000';
        ctx.stroke();

        // Horizontal rules running from the box out to near the image edges
        ctx.lineWidth = Math.max(1, Math.round(fontSizePx * 0.05));
        ctx.strokeStyle = '#000000';
        ctx.beginPath();
        ctx.moveTo(m, lineY);
        ctx.lineTo(boxX, lineY);
        ctx.moveTo(boxX + boxW, lineY);
        ctx.lineTo(canvasW - m, lineY);
        ctx.stroke();

        // Centered black text on top
        ctx.fillStyle = '#000000';
        ctx.fillText(text, cx, lineY + Math.round(fontSizePx * 0.03));
    }

    // Traces a rounded-rect path on ctx (manual path — doesn't rely on the
    // newer ctx.roundRect() so it works on older Chromium builds too).
    function traceRoundedRect(ctx, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.arcTo(x + w, y, x + w, y + rr, rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
        ctx.lineTo(x + rr, y + h);
        ctx.arcTo(x, y + h, x, y + h - rr, rr);
        ctx.lineTo(x, y + rr);
        ctx.arcTo(x, y, x + rr, y, rr);
        ctx.closePath();
    }

    /**
     * Map position name to canvas coordinates + text alignment.
     * Supports 9 anchor points: top-left, top-center, top-right,
     * center-left, center, center-right, bottom-left, bottom-center, bottom-right.
     */
    function getAnchor(position, w, h, margin) {
        const m = margin || 20;
        const map = {
            'top-left': { x: m, y: m, textAlign: 'left', textBaseline: 'top' },
            'top-center': { x: w / 2, y: m, textAlign: 'center', textBaseline: 'top' },
            'top-right': { x: w - m, y: m, textAlign: 'right', textBaseline: 'top' },
            'center-left': { x: m, y: h / 2, textAlign: 'left', textBaseline: 'middle' },
            'center': { x: w / 2, y: h / 2, textAlign: 'center', textBaseline: 'middle' },
            'center-right': { x: w - m, y: h / 2, textAlign: 'right', textBaseline: 'middle' },
            'bottom-left': { x: m, y: h - m, textAlign: 'left', textBaseline: 'bottom' },
            'bottom-center': { x: w / 2, y: h - m, textAlign: 'center', textBaseline: 'bottom' },
            'bottom-right': { x: w - m, y: h - m, textAlign: 'right', textBaseline: 'bottom' }
        };
        return map[position] || map['bottom-right'];
    }

    // ── Utility: data URL → Blob ────────────────────────────────────────────
    function dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
        const bytes = atob(parts[1]);
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        return new Blob([buf], { type: mime });
    }

    // ── Utility: Blob → data URL ────────────────────────────────────────────
    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
})();