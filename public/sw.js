// 這個檔案負責接收伺服器送來的推播通知，並且顯示成手機上的通知橫幅。
// 就算網頁分頁已經關掉，只要瀏覽器允許通知，這支程式還是會在背景執行。

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '荷香早餐店', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '荷香早餐店';
  const options = {
    body: data.body || '',
    tag: data.tag || 'order-status',
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 點通知的時候，把客人帶回訂單狀態頁
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/customer.html');
    })
  );
});
