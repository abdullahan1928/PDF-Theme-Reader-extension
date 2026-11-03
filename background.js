const VIEWER = chrome.runtime.getURL('viewer/viewer.html');

// http(s) PDFs: redirect the navigation itself. Unlike changing the tab's URL
// afterwards, this leaves no extra history entry, so Back works normally.
async function installRedirectRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?src=\\1' } },
      condition: {
        regexFilter: '^(https?://[^#?]+\\.pdf(?:\\?[^#]*)?)$',
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame']
      }
    }]
  });
}

chrome.runtime.onInstalled.addListener(installRedirectRule);
chrome.runtime.onStartup.addListener(installRedirectRule);
installRedirectRule();

// file: URLs are not covered by declarativeNetRequest, so handle them here.
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.tabs.update(details.tabId, {
      url: VIEWER + '?src=' + encodeURIComponent(details.url)
    }).catch(() => { });
  },
  { url: [{ schemes: ['file'], pathSuffix: '.pdf' }, { schemes: ['file'], pathSuffix: '.PDF' }] }
);
