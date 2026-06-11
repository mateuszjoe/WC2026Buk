# Cloud Functions — natychmiastowy push (czat, gole)

Funkcje zdarzeniowe, które wysyłają web push w ~2 s, bez czekania na robota:

- **onChatMessage** — nowa wiadomość na czacie → push do wszystkich (poza autorem)
- **onLiveScore** — gol w `live/state` (wzrost sumy bramek) → push „GOL!”

Finalne wyniki, lider rankingu, ogłoszenia faz i poranne przypomnienia nadal
wysyła robot (`scripts/send-push.mjs`).

## Wdrożenie (jednorazowo)

Wymaga **planu Blaze** w Firebase (przy tej skali realnie 0 zł — darmowy limit
2 mln wywołań/mc) i Firebase CLI.

```bash
# 1. Włącz plan Blaze: Firebase Console → koło zębate → Usage and billing → Upgrade

# 2. Zainstaluj CLI i zaloguj się (raz na komputer)
npm install -g firebase-tools
firebase login

# 3. Wgraj sekret z prywatnym kluczem VAPID (ten sam, co sekret VAPID_PRIVATE_KEY
#    na GitHubie). Wklej wartość, gdy poprosi:
firebase functions:secrets:set VAPID_PRIVATE_KEY

# 4. Zainstaluj zależności i wdróż
cd functions && npm install && cd ..
firebase deploy --only functions
```

Po wdrożeniu: napisz coś na czacie z jednego urządzenia — na innym (z włączonymi
powiadomieniami) push powinien przyjść od razu, nawet przy zamkniętej aplikacji.

> Jeśli `deploy` zgłosi błąd o regionie/lokalizacji bazy — daj znać, dopiszemy
> `region` zgodny z lokalizacją Firestore.
