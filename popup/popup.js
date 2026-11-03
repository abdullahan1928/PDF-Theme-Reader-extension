// The viewer asks for the file itself: a file picker opened from a popup closes
// the popup (and the file handle with it) before the choice can be used.
document.getElementById('open').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
  window.close();
};
document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
