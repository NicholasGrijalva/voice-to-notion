# Notion File Upload Bug Analysis

## Executive Summary

The error `[Notion] File upload failed: Cannot read properties of undefined (reading '0')` is caused by **two distinct bugs** in `/Users/nick/Downloads/voice-to-notion/src/notion.js`, both stemming from the code assuming a Notion API response shape that does not exist.

**Primary bug (the one you are hitting):** Line 87 reads `fileUpload.upload_url`, but the Notion File Upload API does not return an `upload_url` field at the top level of the initial create response in the way the code expects. The actual `upload_url` is `https://api.notion.com/v1/file_uploads/{id}/send` -- it IS present in the response, so line 87 itself works. The crash at `reading '0'` actually occurs deeper, likely from the axios response when the upload POST to that URL fails and the error handler at line 78 tries to access `error.response.data` on an error object whose response is structured differently.

**However**, after re-examining more carefully: the `upload_url` IS returned by the API and line 87 should work. The `reading '0'` error signature points more specifically to the **multi-part path** at **line 119**.

Let me be precise about both paths:

---

## Detailed Analysis

### Bug 1 (CRITICAL -- the crash you are hitting): `uploadSinglePart` -- Line 87

**File:** [notion.js](/Users/nick/Downloads/voice-to-notion/src/notion.js) (Lines 86-103)

```javascript
async uploadSinglePart(fileUpload, filePath, filename, contentType) {
    const uploadUrl = fileUpload.upload_url;  // Line 87
    // ...
    await axios.post(uploadUrl, form, { ... });  // Line 95
}
```

The Notion API *does* return `upload_url` in the create response, so line 87 alone is not the crash site. The `Cannot read properties of undefined (reading '0')` error pattern means something like `someObject[0]` where `someObject` is `undefined`. This is **NOT** a property-access-on-undefined-string pattern -- it is an **array index access**.

Looking at where `[0]` indexing happens in the flow:

1. The error is caught at line 77-80 and logged as `[Notion] File upload failed:`.
2. The actual crash producing `reading '0'` happens inside **axios internals** or from the Notion API response parsing.

**But wait** -- the more likely scenario: the `upload_url` field might be returned but the code is sending the file to it incorrectly, the Notion API returns an error response, and then something in the caller chain tries to index into `undefined[0]`.

Let me trace this differently. The error message `Cannot read properties of undefined (reading '0')` with the log prefix `[Notion] File upload failed:` means the error is caught on line 78. The `error.message` is `Cannot read properties of undefined (reading '0')`. This means the crash happens **before** or **during** the axios call, not from the API returning an error.

**The actual crash site is line 87 or line 119.**

Given that audio files from media-pipeline are typically small (< 20MB), the `isLargeFile` check on line 44 evaluates to `false`, so the code takes the `uploadSinglePart` path at line 71.

Re-reading line 87: `fileUpload.upload_url` -- if this were undefined, the error would be on line 95 when axios tries to parse `undefined` as a URL. The error would be a different message.

**Root cause identified:** The Notion API version `2022-06-28` (line 16) is too old. The File Upload API was released in 2025. The code is using the old API version header but calling the new `/file_uploads` endpoint. The response shape depends on the `Notion-Version` header.

With `Notion-Version: 2022-06-28`, the `/file_uploads` endpoint may:
- Return a 400/404 error, and `createResponse.data` has a different shape
- Return successfully but with a different response schema where `upload_url` is absent

If the endpoint returns an error object like `{ object: 'error', status: 400, ... }`, then `createResponse.data` would have no `upload_url` field, making `fileUpload.upload_url` = `undefined`. Then `axios.post(undefined, ...)` would throw a TypeError, but not specifically `reading '0'`.

### Bug 2 (DEFINITE BUG, affects large files): `uploadMultiPart` -- Line 119

**File:** [notion.js](/Users/nick/Downloads/voice-to-notion/src/notion.js) (Lines 109-141)

```javascript
async uploadMultiPart(fileUpload, filePath, fileSize) {
    // ...
    for (let i = 0; i < numberOfParts; i++) {
        // ...
        const partUploadUrl = fileUpload.part_upload_urls[i];  // Line 119 -- BUG
        // ...
    }
}
```

**This is a definitive bug.** The Notion API does **NOT** return a `part_upload_urls` array. Per the [official API reference](https://developers.notion.com/reference/create-a-file-upload), the response contains a single `upload_url` field. Multi-part uploads send each part to the **same** `upload_url` (`/v1/file_uploads/{id}/send`) with a `part_number` field in the form data. The field `part_upload_urls` is fabricated -- it does not exist in the API response.

If this path were triggered (files > 20MB), `fileUpload.part_upload_urls` would be `undefined`, and `undefined[0]` would produce exactly: `Cannot read properties of undefined (reading '0')`.

---

## Determining Which Bug You Are Actually Hitting

The error `Cannot read properties of undefined (reading '0')` is the **exact signature of line 119** (`fileUpload.part_upload_urls[i]` where `i=0`).

This means either:
1. Your audio files are > 20MB (triggering the multi-part path), OR
2. There is something else going on with the single-part path

Given that the error message perfectly matches line 119's failure mode, **check your audio file sizes**. If they are over 20MB, that is your bug. If they are under 20MB, we need to look elsewhere.

**Most likely diagnosis:** Your audio files ARE over 20MB (uncompressed or long recordings), triggering the `isLargeFile` branch at line 44, which calls `uploadMultiPart` at line 69, which crashes at line 119 on the nonexistent `part_upload_urls` field.

---

## The Fix

### Fix for line 119 (multi-part upload -- the crash):

Replace the `uploadMultiPart` method (lines 109-141) with the correct Notion API multi-part upload flow:

```javascript
/**
 * Upload file in multiple parts (for files > 20MB)
 */
async uploadMultiPart(fileUpload, filePath, fileSize) {
    const partSize = 5 * 1024 * 1024; // 5MB
    const numberOfParts = Math.ceil(fileSize / partSize);
    const fileBuffer = fs.readFileSync(filePath);

    // Notion uses a SINGLE upload_url for all parts -- NOT per-part URLs
    const uploadUrl = fileUpload.upload_url;

    for (let i = 0; i < numberOfParts; i++) {
        const start = i * partSize;
        const end = Math.min(start + partSize, fileSize);
        const partBuffer = fileBuffer.slice(start, end);

        const form = new FormData();
        form.append('file', partBuffer, {
            filename: `part_${i + 1}`,
            contentType: 'application/octet-stream'
        });
        form.append('part_number', String(i + 1));

        await axios.post(uploadUrl, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${this.apiKey}`,
                'Notion-Version': NOTION_API_VERSION
            }
        });

        console.log(`[Notion] Uploaded part ${i + 1}/${numberOfParts}`);
    }

    // Complete the multi-part upload using complete_url from the response
    const completeUrl = fileUpload.complete_url
        || `${NOTION_BASE_URL}/file_uploads/${fileUpload.id}/complete`;
    await axios.post(completeUrl, {}, {
        headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Notion-Version': NOTION_API_VERSION,
            'Content-Type': 'application/json'
        }
    });
}
```

**Changes:**
- Line 119: Replace `fileUpload.part_upload_urls[i]` with the single `fileUpload.upload_url` (used for ALL parts)
- Line 140: Use `fileUpload.complete_url` (returned by the API) or construct the complete endpoint manually, instead of using `this.client.post` which may not include the right headers

### Fix for API version (preventive):

**File:** [notion.js](/Users/nick/Downloads/voice-to-notion/src/notion.js) (Line 16)

The File Upload API requires a newer API version. Update:

```javascript
// Line 16: Update to a version that supports file uploads
const NOTION_API_VERSION = '2022-06-28';  // <-- This may work, but consider updating
```

Per the Notion docs, the File Upload API works with `2022-06-28` but was released as a separate feature. The version header should not cause the issue, but it is worth verifying.

---

## Comprehensive Summary

| Item | Detail |
|------|--------|
| **Error** | `Cannot read properties of undefined (reading '0')` |
| **Crash site** | Line 119: `fileUpload.part_upload_urls[i]` |
| **Root cause** | `part_upload_urls` does not exist in the Notion API response. The code fabricated this field. Multi-part uploads use the same single `upload_url` for every part, differentiating by the `part_number` form field. |
| **Trigger condition** | Audio file > 20MB (line 44 threshold) |
| **Fix** | Replace `fileUpload.part_upload_urls[i]` with `fileUpload.upload_url` on line 119 |
| **Secondary fix** | Line 140: use `fileUpload.complete_url` or direct URL construction instead of `this.client.post` |
| **Severity** | All multi-part file uploads are broken; single-part uploads (< 20MB) should work |

Sources:
- [Notion API - Send a file upload](https://developers.notion.com/reference/send-a-file-upload)
- [Notion API - Uploading small files](https://developers.notion.com/docs/uploading-small-files)
- [Notion API - Uploading larger files](https://developers.notion.com/docs/sending-larger-files)
- [Notion API - Create a file upload](https://developers.notion.com/reference/create-a-file-upload)
