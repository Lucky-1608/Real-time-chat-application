process.env.NODE_ENV = 'test';
process.env.PORT = '4000';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/chat-app-test';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-at-least-32-chars-long';
process.env.CLIENT_URL = 'http://localhost:5173';
process.env.HIBP_ENABLED = 'false';
process.env.ARGON2_MEMORY_KB = '16384';
process.env.ARGON2_TIME_COST = '1';
