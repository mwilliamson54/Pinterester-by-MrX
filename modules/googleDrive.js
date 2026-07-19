/**
 * BulkyGen Google Drive Module
 * Provides pure Google Drive REST API interactions.
 * Expects a valid OAuth access token to be provided by the caller (googleAuth).
 */
(function () {
    'use strict';

    const TAG = 'GoogleDrive';
    const log = () => globalThis.bulkygenLogger;
    
    // Helper to handle 401s centrally
    async function handleAuthError(res, accessToken) {
        if (res.status === 401) {
            if (globalThis.bulkygenGoogleAuth) {
                await globalThis.bulkygenGoogleAuth.removeCachedToken(accessToken);
            }
            throw new Error('OAuth token expired or revoked (401)');
        }
    }

    /**
     * Get or create a subfolder inside a parent folder.
     * @param {string} name - folder name
     * @param {string} parentFolderId - parent folder ID
     * @param {string} accessToken
     * @returns {Promise<string>} folder ID
     */
    async function getOrCreateFolder(name, parentFolderId, accessToken) {
        if (!name) return parentFolderId;
        log()?.info(TAG, `getOrCreateFolder: Checking "${name}" in parent "${parentFolderId}"...`);

        const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and '${parentFolderId}' in parents and trashed = false`;
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`;

        try {
            let res = await fetch(searchUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            await handleAuthError(res, accessToken);

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Folder search failed (${res.status}): ${body}`);
            }

            const data = await res.json();
            if (data.files && data.files.length > 0) {
                return data.files[0].id;
            }

            log()?.info(TAG, `Folder "${name}" not found — creating new folder...`);
            const createUrl = 'https://www.googleapis.com/drive/v3/files';
            const createRes = await fetch(createUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentFolderId]
                })
            });

            await handleAuthError(createRes, accessToken);

            if (!createRes.ok) {
                const body = await createRes.text().catch(() => '');
                throw new Error(`Folder creation failed (${createRes.status}): ${body}`);
            }

            const newFolder = await createRes.json();
            log()?.info(TAG, `Created folder "${name}" successfully: ${newFolder.id}`);
            return newFolder.id;
        } catch (err) {
            log()?.error(TAG, `getOrCreateFolder error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Upload a Blob to Google Drive in multipart format (allows metadata + data).
     * @param {Blob} blob
     * @param {string} filename
     * @param {string} folderId
     * @param {string} accessToken
     * @returns {Promise<{fileId, driveUrl, thumbnailUrl, size, mimeType}>}
     */
    async function uploadFile(blob, filename, folderId, accessToken) {
        log()?.info(TAG, `Uploading file "${filename}" to folder "${folderId}"...`);

        try {
            const arrBuffer = await blob.arrayBuffer();
            const boundary = '-------BulkyGenMultipartBoundary314159';
            const delimiter = `\r\n--${boundary}\r\n`;
            const closeDelimiter = `\r\n--${boundary}--`;

            const metadata = { name: filename };
            if (folderId && folderId !== 'root') {
                metadata.parents = [folderId];
            }

            const metadataPart = new TextEncoder().encode(
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                `Content-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`
            );
            const dataBytes = new Uint8Array(arrBuffer);
            const closePart = new TextEncoder().encode(closeDelimiter);

            const totalLength = metadataPart.length + dataBytes.length + closePart.length;
            const bodyBytes = new Uint8Array(totalLength);
            bodyBytes.set(metadataPart, 0);
            bodyBytes.set(dataBytes, metadataPart.length);
            bodyBytes.set(closePart, metadataPart.length + dataBytes.length);

            const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,thumbnailLink,size';
            const res = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: bodyBytes
            });

            await handleAuthError(res, accessToken);

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                // Check for quota exceeded
                if (res.status === 403 && body.includes('quota')) {
                    throw new Error('Drive storage quota exceeded');
                }
                throw new Error(`Upload failed (${res.status}): ${body}`);
            }

            const data = await res.json();
            log()?.info(TAG, `Successfully uploaded file: ${data.id}`);

            return {
                fileId: data.id,
                driveUrl: data.webViewLink,
                thumbnailUrl: data.thumbnailLink,
                size: parseInt(data.size) || blob.size,
                mimeType: blob.type || 'application/octet-stream'
            };
        } catch (err) {
            log()?.error(TAG, `uploadFile error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Download a file from Drive as a Blob.
     * @param {string} fileId 
     * @param {string} accessToken 
     * @returns {Promise<Blob>}
     */
    async function downloadFile(fileId, accessToken) {
        try {
            const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            await handleAuthError(res, accessToken);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Download failed (${res.status}): ${body}`);
            }
            return await res.blob();
        } catch (err) {
            log()?.error(TAG, `downloadFile error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Update an existing file's content in Drive.
     * @param {string} fileId 
     * @param {Blob} blob 
     * @param {string} accessToken 
     * @returns {Promise<void>}
     */
    async function updateFile(fileId, blob, accessToken) {
        try {
            const url = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
            const res = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': blob.type || 'application/octet-stream'
                },
                body: blob
            });
            await handleAuthError(res, accessToken);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Update file failed (${res.status}): ${body}`);
            }
        } catch (err) {
            log()?.error(TAG, `updateFile error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Delete a file from Drive.
     * @param {string} fileId 
     * @param {string} accessToken 
     * @returns {Promise<void>}
     */
    async function deleteFile(fileId, accessToken) {
        try {
            const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
            const res = await fetch(url, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            await handleAuthError(res, accessToken);
            if (!res.ok && res.status !== 204) {
                const body = await res.text().catch(() => '');
                throw new Error(`Delete failed (${res.status}): ${body}`);
            }
        } catch (err) {
            log()?.error(TAG, `deleteFile error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Read file metadata.
     * @param {string} fileId 
     * @param {string} accessToken 
     * @returns {Promise<Object>}
     */
    async function readFileMetadata(fileId, accessToken) {
        try {
            const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink`;
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            await handleAuthError(res, accessToken);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Read metadata failed (${res.status}): ${body}`);
            }
            return await res.json();
        } catch (err) {
            log()?.error(TAG, `readFileMetadata error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Search files using a query.
     * @param {string} query (e.g. "name contains 'image'")
     * @param {string} accessToken 
     * @returns {Promise<Array>}
     */
    async function searchFiles(query, accessToken) {
        try {
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)`;
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            await handleAuthError(res, accessToken);
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Search failed (${res.status}): ${body}`);
            }
            const data = await res.json();
            return data.files || [];
        } catch (err) {
            log()?.error(TAG, `searchFiles error: ${err.message}`);
            throw err;
        }
    }

    /**
     * List all files in a given folder.
     * @param {string} parentFolderId 
     * @param {string} accessToken 
     * @returns {Promise<Array>}
     */
    async function listFiles(parentFolderId, accessToken) {
        const query = `'${parentFolderId}' in parents and trashed = false`;
        return await searchFiles(query, accessToken);
    }

    /**
     * Read a folder's basic metadata to confirm it exists and is a folder.
     * @param {string} folderId 
     * @param {string} accessToken 
     * @returns {Promise<Object>}
     */
    async function readFolder(folderId, accessToken) {
        const meta = await readFileMetadata(folderId, accessToken);
        if (meta.mimeType !== 'application/vnd.google-apps.folder') {
            throw new Error(`ID ${folderId} is not a folder.`);
        }
        return meta;
    }

    globalThis.bulkygenGoogleDrive = {
        uploadFile,
        getOrCreateFolder,
        downloadFile,
        updateFile,
        deleteFile,
        readFileMetadata,
        searchFiles,
        listFiles,
        readFolder
    };
})();
