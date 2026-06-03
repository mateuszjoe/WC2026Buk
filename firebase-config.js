// =============================================================================
//  KONFIGURACJA FIREBASE  ——  TO JEST JEDYNY PLIK, KTÓRY MUSISZ WYPEŁNIĆ
// =============================================================================
//
// Te wartości NIE są tajne (klucz "apiKey" to identyfikator projektu, nie hasło)
// — bezpiecznie trafiają do repozytorium i na GitHub Pages. Dostęp do danych
// pilnują reguły Firestore (plik firestore.rules), nie ten plik.
//
// SKĄD TO WZIĄĆ (raz, ~5 minut):
//   1. Wejdź na https://console.firebase.google.com → "Dodaj projekt".
//   2. W projekcie: ikonka </> ("Dodaj aplikację → Web"), nadaj nazwę.
//   3. Firebase pokaże obiekt "firebaseConfig" — skopiuj wartości tutaj poniżej.
//   4. W menu "Authentication" → "Sign-in method" → włącz "Google".
//   5. W menu "Firestore Database" → "Utwórz bazę" (tryb produkcyjny).
//   6. W zakładce "Rules" wklej zawartość pliku firestore.rules z tego repo.
//   7. W "Authentication → Settings → Authorized domains" dodaj swój adres
//      GitHub Pages, np. twojlogin.github.io
//
// =============================================================================

export const firebaseConfig = {
  apiKey: "WKLEJ_TUTAJ",
  authDomain: "WKLEJ_TUTAJ.firebaseapp.com",
  projectId: "WKLEJ_TUTAJ",
  storageBucket: "WKLEJ_TUTAJ.appspot.com",
  messagingSenderId: "WKLEJ_TUTAJ",
  appId: "WKLEJ_TUTAJ"
};
