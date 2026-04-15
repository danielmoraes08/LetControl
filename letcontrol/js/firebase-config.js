
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