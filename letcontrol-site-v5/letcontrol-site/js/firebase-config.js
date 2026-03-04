const firebaseConfig = {
  apiKey:            "AIzaSyCSeKTU6l9RY46olPmg3ISIVDafcyEg9wI",
  authDomain:        "letcontrol-app.firebaseapp.com",
  projectId:         "letcontrol-app",
  storageBucket:     "letcontrol-app.firebasestorage.app",
  messagingSenderId: "805791650923",
  appId:             "1:805791650923:web:b634005d4142254d238d2e"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db   = firebase.firestore();
