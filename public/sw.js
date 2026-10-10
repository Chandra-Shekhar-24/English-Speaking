// ============================================================
// public/sw.js — VocaMate Service Worker for PWA & Incoming Call Push
// ============================================================
const CACHE_NAME = 'vocamate-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Real-time Push Notification for Incoming Friend Calls
self.addEventListener('push', (event) => {
  let data = {
    title: '📞 Incoming Call',
    body: 'A friend is calling you on VocaMate',
    icon: '/favicon.ico',
    tag: 'incoming-call',
    data: {}
  };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const callId = data.data && data.data.callId;
  const isVideo = data.data && data.data.isVideo;

  const options = {
    body: data.body,
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.tag || (callId ? `call-${callId}` : 'incoming-call'),
    renotify: true,
    requireInteraction: true,
    vibrate: [500, 250, 500, 250, 500, 250, 500],
    data: data.data || {},
    actions: [
      { action: 'answer', title: isVideo ? '🎥 Answer Video' : '📞 Answer Call' },
      { action: 'decline', title: '✖ Decline' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const action = event.action;
  const callId = notificationData.callId;

  if (action === 'decline') {
    // Send background decline if possible
    if (callId) {
      event.waitUntil(
        fetch('/api/calls/decline-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId })
        }).catch(() => {})
      );
    }
    return;
  }

  // Action is answer or user tapped the notification card
  const targetUrl = notificationData.url || (callId ? `/?answerCall=${encodeURIComponent(callId)}` : '/');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it and tell it about the call
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({
            type: 'ANSWER_INCOMING_CALL',
            callId: callId,
            data: notificationData
          });
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
