// Part of background.js, split out for readability. Runs in the same
// service-worker global scope as background.js and the other
// background/*.js files (loaded via importScripts — NOT ES modules),
// so everything here shares state (isRunning, isPaused, etc.) with them
// exactly as it did when this was all one file.



async function startGeneration(resumeTabId) {
  if (loopActive) return; // a loop is already running in this worker
  loopActive = true;
  loopActiveSince = Date.now();
  isRunning = true;
  markLoopProgress('starting');
  if (resumeTabId == null) { isPaused = false; __runCapturedHashes.clear(); }
  try {
    await ext.storage.local.set({ isRunning: true, isPaused });
    startSwKeepAlive();
    armKeepAliveAlarm();

    let tabId = resumeTabId;
    markLoopProgress('finding_tab');

    if (tabId == null) {
      // 1. Try the currently active tab first
      const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (activeTab && isSupportedTabUrl(activeTab.url)) {
        tabId = activeTab.id;
      } else {
        // 2. Search ALL open tabs for any supported generator page
        const allTabs = await ext.tabs.query({});
        const supportedTab = allTabs.find(t => isSupportedTabUrl(t.url));
        if (supportedTab) {
          tabId = supportedTab.id;
          console.log(`BulkyGen: Using background tab ${tabId} (${supportedTab.url.slice(0, 60)}...)`);
        } else {
          // 3. No supported page open anywhere — report error and exit
          const msg = 'No supported generator page found. Please open one of:\n- Flow: https://labs.google/fx/tools/flow/project\n- Meta AI: https://www.meta.ai/media\n- Grok: https://grok.com/imagine\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image';
          logToExtension('warn', 'Background', 'startGeneration aborted — no supported tab found. ' + msg.split('\n')[0]);
          notifyPopup('generationError', { message: msg });
          await _reportPipelineStartFailure('No supported generator page found');
          await _failQueuedItems('No supported generator page found');
          isRunning = false;
          loopActive = false; loopActiveSince = null;
          await ext.storage.local.set({ isRunning: false });
          return;
        }
      }
    }

    currentTabId = tabId;
    await ext.storage.local.set({ genTabId: tabId });
    logToExtension('info', 'Background', `startGeneration: using tab ${tabId}`);
    // Hold the page's silent-audio keep-alive for the entire run so it stays
    // unthrottled in the background between every prompt / fetch / retry.
    try { ext.tabs.sendMessage(tabId, { action: 'bgKeepAlive', on: true }).catch(() => { }); } catch (e) { }
    let currentProvider = 'unknown';

    // Make sure the content script is loaded (no manual page reload needed).
    // Bounded: executeScript can hang indefinitely on awkward tab states.
    markLoopProgress('ensure_cs');
    logToExtension('info', 'Background', `Ensuring content script on tab ${currentTabId}...`);
    const csOk = await ensureTabContentScript(currentTabId);
    if (!csOk) {
      logToExtension('warn', 'Background', `ensureTabContentScript did not confirm injection on tab ${currentTabId}; continuing to checkPage anyway.`);
    } else {
      markLoopProgress('ensure_cs_done');
    }

    // Verify we're on a supported page (works without `tabs` permission)
    // Retry a few times: right after ensureTabContentScript() resolves, the
    // content script may not have finished registering its message listener
    // yet (a common MV3 race — "Receiving end does not exist"). Each attempt
    // is also time-bounded so a hung tabs.sendMessage cannot burn 300s.
    markLoopProgress('check_page');
    let checkRes = null;
    let checkErr = null;
    for (let i = 0; i < 4; i++) {
      if (!isRunning) break;
      try {
        logToExtension('info', 'Background', `checkPage attempt ${i + 1}/4 on tab ${currentTabId}...`);
        const res = await withTimeout(
          ext.tabs.sendMessage(currentTabId, { action: 'checkPage' }),
          5000,
          `checkPage attempt ${i + 1}`
        );
        if (res && res.isSupportedPage) {
          checkRes = res;
          break;
        }
        checkErr = new Error('Unsupported page');
      } catch (e) {
        checkErr = e;
        logToExtension('warn', 'Background', `checkPage attempt ${i + 1}/4 failed: ${e?.message || e}`);
      }
      await sleep(500);
    }

    if (!checkRes) {
      const reason = `checkPage failed: ${checkErr?.message || 'unsupported page'}`;
      logToExtension('warn', 'Background', `startGeneration aborted — checkPage never succeeded on tab ${currentTabId} (${checkErr?.message || 'unknown reason'}).`);
      notifyPopup('generationError', {
        message: 'Please navigate to a supported page:\n- Flow: https://labs.google/fx/tools/flow/project\n- Digen: https://digen.ai/image\n- Gentube: https://www.gentube.app/create\n- Firefly: https://firefly.adobe.com/generate/image\n- Meta AI: https://www.meta.ai/media\n- Grok: https://x.com/i/grok'
      });
      await _reportPipelineStartFailure(reason);
      await _failQueuedItems(reason);
      isRunning = false;
      loopActive = false; loopActiveSince = null;
      await ext.storage.local.set({ isRunning: false });
      return;
    }
    currentProvider = checkRes.provider || 'unknown';
    markLoopProgress('generating');
    logToExtension('info', 'Background', `Using provider="${currentProvider}" on tab ${currentTabId} for this run.`);

    const data = await ext.storage.local.get(['queue', 'delay']);
    const queue = data.queue || [];
    const delay = (data.delay || 1) * 1000; // Faster default delay (1s)

    if (currentProvider === 'flow') {
      await runFlowSequentialGeneration(queue, delay);
    } else {
      // Generic provider loop (Digen, Gentube, Meta AI, Grok, ...).
      // Same guarantees as Flow: NEVER FAIL (infinite, immediate retry until media
      // is actually captured) and ZERO delay between prompts. Runs in the
      // background no matter which tab is focused (keep-alive + background-safe
      // waits live in the content script).
      const MAX_RETRIES = Infinity;   // never give up on a prompt
      const RETRY_BACKOFF_MS = 0;     // retry instantly
      const GENERIC_GAP_MS = 0;       // no spacing between successful prompts
      const isGrok = currentProvider === 'grok';

      for (let i = 0; i < queue.length && isRunning; i++) {
        if (queue[i].status === 'completed') continue;

        // Honor Pause without losing our place in the queue.
        await waitWhilePaused();
        if (!isRunning) break;

        // Mark current item as processing.
        queue[i].status = 'processing';
        await ext.storage.local.set({ queue, currentIndex: i });
        notifyPopup('updateQueue', { queue });

        let attempt = 0;
        let succeeded = false;
        let fatalDisconnect = false;

        while (attempt <= MAX_RETRIES && isRunning && !succeeded) {
          try {
            await ensureTabContentScript(currentTabId);

            // Ask the content script to generate for this prompt.
            // Register a fallback waiter FIRST: long generations can outlive the
            // sendMessage response channel in MV3. If the channel closes, we wait
            // for the content script's pushed result instead of regenerating.
            const __waiter = registerResultWaiter(queue[i].id, 300000);
            let response;
            try {
              response = await ext.tabs.sendMessage(currentTabId, {
                action: 'generateImage',
                prompt: queue[i].prompt,
                itemId: queue[i].id
              });
              __waiter.cancel();
            } catch (sendErr) {
              const smsg = (sendErr && sendErr.message) || String(sendErr);
              if (/message channel closed|asynchronous response|message port closed/i.test(smsg)) {
                console.log(`⏳ ${currentProvider}: response channel closed for prompt ${i + 1}; awaiting pushed result (no regeneration)...`);
                response = await __waiter.promise;
                if (!response) {
                  throw new Error('Generation result not received after the response channel closed');
                }
              } else {
                __waiter.cancel();
                throw sendErr;
              }
            }

            if (!response || !response.success) {
              throw new Error(response?.error || 'Generation failed');
            }

            // Save whatever media came back.
            let captured = false;
            if (response.multipleVideos && Array.isArray(response.multipleVideos) && response.multipleVideos.length) {
              // Meta AI: multiple videos per prompt.
              console.log(`\u{1F4F9} Saving ${response.multipleVideos.length} Meta AI videos...`);
              for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
                const videoData = response.multipleVideos[videoIdx];
                try {
                  await saveGeneratedImage(
                    videoData.imageData,
                    `${queue[i].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
                    queue[i].id,
                    videoData.meta
                  );
                  captured = true;
                } catch (saveError) {
                  console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
                }
              }
            } else if (response.imageData) {
              // Single image/video for the other providers. If it's a duplicate of
              // an image already captured for an earlier slot, fail so the loop
              // auto-retries and regenerates a fresh one for THIS slot.
              if (isDuplicateCapture(response.imageData)) {
                throw new Error('Only a duplicate of an earlier image was captured; regenerating for a fresh result');
              }
              await saveGeneratedImage(response.imageData, queue[i].prompt, queue[i].id, response.meta);
              captured = true;
            }

            // Nothing captured -> treat as failure so it auto-retries in place.
            if (!captured) {
              const why = response.meta && response.meta.captureError
                ? `capture failed: ${response.meta.captureError}`
                : 'no media captured';
              throw new Error(why);
            }

            // Success.
            queue[i].status = 'completed';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });
            succeeded = true;

            // Deliver result to pipeline if this item originated from autonomous mode
            if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
              try {
                globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
                  success: true,
                  imageData: response.imageData,
                  multipleImages: response.multipleVideos || null,
                  meta: response.meta
                });
              } catch (e) { /* ignore */ }
            }

            // For Grok: go back to the homepage so the next prompt is ready.
            if (response.needsNavigation && response.navigateTo) {
              console.log('\u{1F504} Grok: navigating to', response.navigateTo, 'for next generation...');
              try {
                await ext.tabs.update(currentTabId, { url: response.navigateTo });
                await waitForPageReady(currentTabId, 30);
              } catch (navErr) {
                console.error('Grok navigation error:', navErr);
              }
            }
          } catch (error) {
            console.error('Generation error:', error);

            // A dead content-script connection can't be retried on this tab as-is;
            // try one forced re-inject, otherwise stop the run.
            if (error.message && error.message.includes('Could not establish connection')) {
              try {
                await ensureTabContentScript(currentTabId, true);
                await sleep(500);
              } catch (reinjectErr) {
                fatalDisconnect = true;
                break;
              }
            }

            attempt++;
            console.log(`\u{1F501} ${currentProvider}: prompt ${i + 1} failed (${error.message}); retrying immediately (attempt ${attempt})...`);
            notifyPopup('generationError', {
              message: `Prompt ${i + 1} failed (${error.message.replace('CONTENT_MODERATED: ', '')}); auto-retrying...`
            });

            // Keep the slot marked processing while we retry in place.
            queue[i].status = 'processing';
            await ext.storage.local.set({ queue });
            notifyPopup('updateQueue', { queue });

            // For Grok: failures (moderation/timeout) need a return to the
            // homepage before the next attempt can work.
            if (isGrok) {
              try {
                await ext.tabs.update(currentTabId, { url: 'https://grok.com/imagine/' });
                await waitForPageReady(currentTabId, 30);
              } catch (navError) {
                console.error('Navigation error:', navError);
              }
            }

            if (RETRY_BACKOFF_MS > 0) await sleep(RETRY_BACKOFF_MS);
          }
        }

        await ext.storage.local.set({ queue });
        notifyPopup('updateQueue', { queue });

        if (fatalDisconnect) {
          notifyPopup('generationError', {
            message: 'Content script not loaded. Please refresh the current generator page and try again.'
          });
          isRunning = false;
          break;
        }

        // Move to the next prompt the instant this one's media is captured.
        const hasMorePending = queue.slice(i + 1).some(item => item.status !== 'completed');
        if (hasMorePending && isRunning && GENERIC_GAP_MS > 0) {
          await sleep(GENERIC_GAP_MS);
        }
      }
    }
    // Generation complete
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    notifyPopup('generationComplete', {});

    // Show system notification
    if (ext.notifications) {
      ext.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'BulkyGen Complete',
        message: 'Bulk generation process finished.'
      });
    }
  } finally {
    loopActive = false; loopActiveSince = null;
    markLoopProgress('idle');
    // Notify any pipeline waiters that the loop is gone so they fail fast
    // instead of burning their full 300-second timeout with zero activity.
    // This is the single most important escape hatch: if startGeneration exits
    // for ANY reason (tab gone, checkPage failed, fatalDisconnect, normal finish)
    // the pipeline learns about it within milliseconds instead of 300 seconds.
    try { globalThis.bulkygenPipeline?.onGenerationLoopDied?.(); } catch (e) { /* ignore */ }
    if (!isRunning) {
      stopSwKeepAlive();
      disarmKeepAliveAlarm();
      if (currentTabId != null) {
        try { ext.tabs.sendMessage(currentTabId, { action: 'bgKeepAlive', on: false }).catch(() => { }); } catch (e) { }
      }
    }
  }
}

async function runFlowSequentialGeneration(queue, delay) {
  // Inject prompts into the Flow project ONE BY ONE (line by line). For each
  // prompt we type it into the composer, click generate, and wait until the
  // image is actually captured. The INSTANT the image is fetched we move on to
  // the next prompt with zero added delay ("lightning fast").
  //
  // If a prompt fails (error, timeout, or no image captured) we AUTO-RETRY the
  // SAME queue slot a few times before giving up, so a transient failure self-
  // heals without losing its place in the queue.
  // NEVER FAIL: keep retrying the same prompt until it actually produces an
  // image. Retries fire IMMEDIATELY (no backoff). The only things that end the
  // loop are a successful capture or the user pressing Stop (isRunning = false).
  // Bounded retries with a short gap between attempts. This used to be
  // Infinity/0ms — an unconditional, zero-delay retry loop. If Flow's page
  // (composer or generate button) simply couldn't be located, that spun
  // silently forever: every attempt failed instantly and re-tried instantly,
  // so nothing was ever typed, no diagnostic ever reached the visible logs
  // (content-script console.log only appears in the Flow tab's own DevTools,
  // not the service worker inspector), and the record just sat there until
  // the pipeline's separate 300s timeout eventually gave up on its own. Now a
  // real failure reason surfaces (via logToExtension) after a handful of
  // quick attempts instead of hanging silently for the full 5 minutes.
  const MAX_RETRIES = 8;
  const RETRY_BACKOFF_MS = 1500;
  const FLOW_GAP_MS = 0;          // no spacing between successful prompts

  for (let i = 0; i < queue.length && isRunning; i++) {
    if (queue[i].status === 'completed') continue;

    // Honor Pause without losing our place in the queue.
    await waitWhilePaused();
    if (!isRunning) break;

    // Mark current line as processing
    queue[i].status = 'processing';
    await ext.storage.local.set({ queue, currentIndex: i });
    notifyPopup('updateQueue', { queue });

    let attempt = 0;
    let succeeded = false;
    let fatalDisconnect = false;

    while (attempt <= MAX_RETRIES && isRunning && !succeeded) {
      try {
        await ensureTabContentScript(currentTabId);

        // Register a fallback waiter FIRST: Flow generations (composer inject +
        // click + up to 120s waiting for the result image) can easily outlive
        // the sendMessage response channel in MV3. Previously, any channel error
        // here caused an immediate re-inject-and-resend of the SAME prompt, even
        // though Flow could still be generating the original one server-side —
        // that duplicate resubmission (plus the lost original result) is what
        // made this loop spin and always burn through the full 300s pipeline
        // timeout. Now we wait for the content script's pushed result instead
        // of resubmitting whenever the error looks like a closed channel.
        const __flowWaiter = registerResultWaiter(queue[i].id, 180000);
        let result;
        markLoopProgress('flow_submit');
        logToExtension('info', 'Flow', `Sending flowSubmitPrompt for item ${queue[i].id} (prompt ${i + 1}/${queue.length})...`);
        try {
          // Race sendMessage against the pushed-result waiter so a hung response
          // channel (or a content script that never sendResponse's) cannot block
          // forever. Content also pushes generationResult independently.
          result = await Promise.race([
            ext.tabs.sendMessage(currentTabId, {
              action: 'flowSubmitPrompt',
              prompt: queue[i].prompt,
              itemId: queue[i].id,
              aspectRatio: queue[i].aspectRatio || null
            }),
            __flowWaiter.promise.then((r) => {
              if (r == null) throw new Error('flowSubmitPrompt timed out waiting for generation result');
              return r;
            })
          ]);
          __flowWaiter.cancel();
          markLoopProgress('flow_result');
        } catch (sendErr) {
          const smsg = (sendErr && sendErr.message) || String(sendErr);
          if (/message channel closed|asynchronous response|message port closed/i.test(smsg)) {
            console.log(`⏳ flow: response channel closed for prompt ${i + 1}; awaiting pushed result (no regeneration)...`);
            logToExtension('info', 'Flow', `Response channel closed for prompt ${i + 1}; awaiting pushed result...`);
            result = await __flowWaiter.promise;
            if (!result) {
              throw new Error('Generation result not received after the response channel closed');
            }
            markLoopProgress('flow_result');
          } else if (/timed out waiting for generation result/i.test(smsg)) {
            __flowWaiter.cancel();
            throw sendErr;
          } else {
            __flowWaiter.cancel();
            // Content script unreachable -> force re-inject and retry once.
            logToExtension('warn', 'Flow', `flowSubmitPrompt send failed (${smsg}); reinjecting content script and retrying once...`);
            await ensureTabContentScript(currentTabId, true);
            await sleep(400);
            const __flowWaiter2 = registerResultWaiter(queue[i].id, 180000);
            markLoopProgress('flow_submit_retry');
            try {
              result = await Promise.race([
                ext.tabs.sendMessage(currentTabId, {
                  action: 'flowSubmitPrompt',
                  prompt: queue[i].prompt,
                  itemId: queue[i].id,
                  aspectRatio: queue[i].aspectRatio || null
                }),
                __flowWaiter2.promise.then((r) => {
                  if (r == null) throw new Error('flowSubmitPrompt timed out waiting for generation result (retry)');
                  return r;
                })
              ]);
              __flowWaiter2.cancel();
              markLoopProgress('flow_result');
            } catch (sendErr2) {
              const smsg2 = (sendErr2 && sendErr2.message) || String(sendErr2);
              if (/message channel closed|asynchronous response|message port closed/i.test(smsg2)) {
                console.log(`⏳ flow: response channel closed for prompt ${i + 1} (retry); awaiting pushed result (no regeneration)...`);
                result = await __flowWaiter2.promise;
                if (!result) {
                  throw new Error('Generation result not received after the response channel closed');
                }
                markLoopProgress('flow_result');
              } else {
                __flowWaiter2.cancel();
                throw sendErr2;
              }
            }
          }
        }

        // Collect captured images (Flow x2 / x4 produce multiple per prompt).
        const flowImgs = Array.isArray(result?.multipleImages) && result.multipleImages.length
          ? result.multipleImages
          : (result?.imageData ? [{ imageData: result.imageData, meta: result.meta }] : []);

        // Treat "no image captured" the same as a failure so it auto-retries.
        if (!result?.success || flowImgs.length === 0) {
          throw new Error(result?.error || 'No image captured');
        }

        // Drop any image already captured for an earlier slot (Flow can re-serve
        // the prior preview). If NONE are new, fail so we regenerate a genuinely
        // fresh image for THIS slot.
        const freshFlowImgs = flowImgs.filter(fi => !isDuplicateCapture(fi.imageData));
        if (freshFlowImgs.length === 0) {
          throw new Error('Only a duplicate of an earlier image was captured; regenerating for a fresh result');
        }

        for (let n = 0; n < freshFlowImgs.length; n++) {
          try {
            const label = freshFlowImgs.length > 1
              ? `${queue[i].prompt} (${n + 1}/${freshFlowImgs.length})`
              : queue[i].prompt;
            await saveGeneratedImage(freshFlowImgs[n].imageData, label, queue[i].id, freshFlowImgs[n].meta);
          } catch (saveError) {
            console.error('Flow image save error (continuing):', saveError);
          }
        }

        queue[i].status = 'completed';
        succeeded = true;

        // Deliver result to pipeline if this item originated from autonomous mode
        if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
          try {
            globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
              success: true,
              imageData: freshFlowImgs[0]?.imageData,
              multipleImages: freshFlowImgs,
              meta: freshFlowImgs[0]?.meta
            });
          } catch (e) { /* ignore */ }
        }
      } catch (err) {
        // A dead content-script connection can't be fixed by retrying the same
        // tab, so stop the whole run and ask for a refresh.
        if (err.message && err.message.includes('Could not establish connection')) {
          fatalDisconnect = true;
          break;
        }

        attempt++;
        if (attempt > MAX_RETRIES) {
          queue[i].status = 'error';
          logToExtension('warn', 'Flow', `Prompt ${i + 1} failed after ${MAX_RETRIES + 1} tries: ${err.message}`);
          notifyPopup('generationError', {
            message: `Flow prompt ${i + 1} failed after ${MAX_RETRIES + 1} tries: ${err.message}`
          });
          // Report failure to the pipeline right away instead of leaving it to
          // burn out its own separate 300s wait with no information.
          if (queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
            try {
              globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
                success: false,
                error: err.message
              });
            } catch (e) { /* ignore */ }
          }
        } else {
          logToExtension('warn', 'Flow', `Prompt ${i + 1} failed (${err.message}); auto-retrying (attempt ${attempt}/${MAX_RETRIES})...`);
          // Keep the slot marked as processing while we retry it in place.
          queue[i].status = 'processing';
          await ext.storage.local.set({ queue });
          notifyPopup('updateQueue', { queue });
          await sleep(RETRY_BACKOFF_MS);
        }
      }
    }

    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });

    if (fatalDisconnect) {
      notifyPopup('generationError', {
        message: 'Content script not loaded. Please refresh the Flow project page and try again.'
      });
      // Deliver failure to any pipeline waiter for the current item so it retries
      // immediately instead of hanging for the full 300-second timeout.
      if (queue[i] && queue[i]._pipelineRecordId && globalThis.bulkygenPipeline) {
        try {
          globalThis.bulkygenPipeline.deliverGenerationResult(queue[i].id, {
            success: false,
            error: 'Content script fatal disconnect — page needs refresh'
          });
        } catch (e) { /* ignore */ }
      }
      isRunning = false;
      break;
    }

    // Move to the next prompt the instant this one's image is captured.
    const hasMorePending = queue.slice(i + 1).some(item => item.status !== 'completed');
    if (hasMorePending && isRunning && FLOW_GAP_MS > 0) {
      await sleep(FLOW_GAP_MS);
    }
  }
}
async function regenerateSingleItem(itemId) {
  if (!itemId) return;
  if (isRunning) {
    throw new Error('Generation is already running');
  }

  isRunning = true;
  await ext.storage.local.set({ isRunning: true });

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  let currentProvider = 'unknown';

  try {
    const res = await ext.tabs.sendMessage(currentTabId, { action: 'checkPage' });
    if (!res || !res.isSupportedPage) throw new Error('Unsupported page');
    currentProvider = res.provider || 'unknown';
  } catch {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    throw new Error('Please navigate to a supported page (Flow, Digen, Meta AI, or Grok) before regenerating.');
  }

  const data = await ext.storage.local.get(['queue', 'delay']);
  const queue = data.queue || [];
  const idx = queue.findIndex(q => q.id === itemId);
  if (idx === -1) {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
    return;
  }

  // Tab activation removed to support background execution
  // Content script handles keep-alive

  queue[idx].status = 'processing';
  await ext.storage.local.set({ queue, currentIndex: idx });
  notifyPopup('updateQueue', { queue });

  try {
    await ensureTabContentScript(currentTabId);
    const response = await ext.tabs.sendMessage(currentTabId, {
      action: currentProvider === 'flow' ? 'flowSubmitPrompt' : 'generateImage',
      prompt: queue[idx].prompt,
      itemId: queue[idx].id,
      aspectRatio: queue[idx].aspectRatio || null
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Generation failed');
    }

    if (currentProvider !== 'flow') {
      // Save image/video data if provided
      // For Meta AI: handle multiple videos
      if (response.multipleVideos && Array.isArray(response.multipleVideos)) {
        console.log(`📹 Saving ${response.multipleVideos.length} Meta AI videos...`);
        for (let videoIdx = 0; videoIdx < response.multipleVideos.length; videoIdx++) {
          const videoData = response.multipleVideos[videoIdx];
          try {
            await saveGeneratedImage(
              videoData.imageData,
              `${queue[idx].prompt} (Video ${videoIdx + 1}/${response.multipleVideos.length})`,
              queue[idx].id,
              videoData.meta
            );
          } catch (saveError) {
            console.error(`Video ${videoIdx + 1} save error (continuing):`, saveError);
          }
        }
      } else if (response.imageData) {
        // Single image/video for other providers
        try {
          await saveGeneratedImage(response.imageData, queue[idx].prompt, queue[idx].id, response.meta);
        } catch (saveError) {
          console.error('Image save error (continuing):', saveError);
          notifyPopup('imageSaveError', {
            message: saveError?.message || 'Failed to save image data (continuing)'
          });
        }
      }
    } else {
      // Flow: save ALL captured images (x2 / x4 produce multiple)
      const flowImgs = Array.isArray(response.multipleImages) && response.multipleImages.length
        ? response.multipleImages
        : (response.imageData ? [{ imageData: response.imageData, meta: response.meta }] : []);
      for (let n = 0; n < flowImgs.length; n++) {
        try {
          const label = flowImgs.length > 1
            ? `${queue[idx].prompt} (${n + 1}/${flowImgs.length})`
            : queue[idx].prompt;
          await saveGeneratedImage(flowImgs[n].imageData, label, queue[idx].id, flowImgs[n].meta);
        } catch (saveError) {
          console.error('Flow image save error (continuing):', saveError);
        }
      }
    }

    queue[idx].status = 'completed';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
  } catch (error) {
    queue[idx].status = 'error';
    await ext.storage.local.set({ queue });
    notifyPopup('updateQueue', { queue });
    throw error;
  } finally {
    isRunning = false;
    await ext.storage.local.set({ isRunning: false });
  }
}