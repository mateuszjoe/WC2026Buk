// Minimalny service worker — wyłącznie po to, żeby aplikację dało się
// zainstalować (PWA) i żeby mogła pokazywać powiadomienia na telefonie.
// NIE cache'ujemy zasobów (żeby nie serwować starych wersji po deployu).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Pusty handler fetch — wymagany do instalowalności; przepuszczamy do sieci.
self.addEventListener("fetch", () => {});

// Kliknięcie w powiadomienie → otwórz/uaktywuj okno aplikacji.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

// (Na przyszłość) prawdziwy push z serwera/robota przez FCM.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "Typer MŚ 2026";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png"
    })
  );
});
