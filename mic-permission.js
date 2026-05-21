const status = document.getElementById('status');

navigator.mediaDevices.getUserMedia({ audio: true })
  .then(stream => {
    stream.getTracks().forEach(t => t.stop());
    status.textContent = 'Mic access granted! This tab will close...';
    chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' });
    setTimeout(() => window.close(), 1200);
  })
  .catch(err => {
    status.textContent = 'Mic access denied. Please allow and try again.';
    console.error('Mic permission error:', err);
  });
