/*const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};*/

const firebaseConfig = {
  apiKey: "AIzaSyDMbNYMcQXNaSVht25kCQZ2e0T9rza3F8g",
  authDomain: "letcontrol-database.firebaseapp.com",
  projectId: "letcontrol-database",
  storageBucket: "letcontrol-database.firebasestorage.app",
  messagingSenderId: "993338285265",
  appId: "1:993338285265:web:08cb2d6330f2433d5679f0",
  databaseURL: "https://letcontrol-database-default-rtdb.firebaseio.com",
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const rtdb  = firebase.database();