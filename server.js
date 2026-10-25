const dotenv = require('dotenv');
dotenv.config();

const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const app = require('./app');
const User = require('./models/User');
const ChatMessage = require('./models/ChatMessage');
const ChatSession = require('./models/ChatSession');
const { canUserAccessSession } = require('./services/chatAuthorization.service');
const { logIntegrationStatus } = require('./services/integrationStatus.service');

function allowedSocketOrigins() {
  const configured = [
    process.env.FRONTEND_URL,
    ...(process.env.SOCKET_CORS_ORIGINS || '').split(','),
  ].map((item) => item?.trim()).filter(Boolean);

  if (process.env.NODE_ENV !== 'production') {
    configured.push('http://localhost:3000', 'http://localhost:5173');
  }
  return [...new Set(configured)];
}

function extractSocketToken(socket) {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return String(authToken).replace(/^Bearer\s+/i, '').trim();

  const authorization = socket.handshake.headers?.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim();
  return null;
}

async function authenticateSocket(socket, next) {
  try {
    const token = extractSocketToken(socket);
    if (!token) return next(new Error('Authentication required'));
    if (!process.env.JWT_SECRET) return next(new Error('Server authentication configuration error'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) return next(new Error('Invalid or inactive user'));
    if (!user.profileId) return next(new Error('Profile required for chat'));

    socket.user = user;
    next();
  } catch (error) {
    next(new Error(error.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid authentication token'));
  }
}

const startServer = async () => {
  try {
    await connectDB();
    console.log('✅ MongoDB Connected');

    const PORT = process.env.PORT || 5000;
    const server = http.createServer(app);
    const origins = allowedSocketOrigins();

    const io = new Server(server, {
      cors: {
        origin: origins.length ? origins : false,
        credentials: true,
      },
    });

    io.use(authenticateSocket);

    io.on('connection', (socket) => {
      console.log(`🔌 Authenticated socket: ${socket.id} user=${socket.user.id}`);

      socket.on('join_chat', async (data = {}, ack) => {
        try {
          const sessionId = data.sessionId;
          if (!sessionId) throw new Error('sessionId is required');

          const session = await ChatSession.findById(sessionId).lean();
          if (!session) throw new Error('Chat session not found');
          if (!canUserAccessSession(socket.user, session)) throw new Error('Not authorized for this chat session');

          socket.join(String(session._id));
          if (typeof ack === 'function') ack({ success: true, sessionId: String(session._id) });
        } catch (error) {
          if (typeof ack === 'function') ack({ success: false, error: error.message });
          else socket.emit('chat_error', { error: error.message });
        }
      });

      socket.on('send_message', async (data = {}, ack) => {
        try {
          const { sessionId, messageType = 'text', fileUrl } = data;
          const content = typeof data.content === 'string' ? data.content.trim() : '';

          if (!sessionId || !content) throw new Error('sessionId and content are required');
          if (content.length > 5000) throw new Error('Message is too long');
          if (!['text', 'image', 'document'].includes(messageType)) throw new Error('Unsupported message type');

          const session = await ChatSession.findById(sessionId).lean();
          if (!session) throw new Error('Chat session not found');
          if (!canUserAccessSession(socket.user, session)) throw new Error('Not authorized for this chat session');

          // SECURITY: sender identity is always derived from the authenticated JWT.
          const msg = await ChatMessage.create({
            sessionId: session._id,
            senderId: socket.user.profileId,
            senderType: socket.user.role,
            content,
            messageType,
            fileUrl,
            isRead: false,
          });

          await ChatSession.findByIdAndUpdate(session._id, {
            $set: { lastMessage: msg._id, updatedAt: new Date() },
          });

          io.to(String(session._id)).emit('receive_message', msg.toJSON());
          if (typeof ack === 'function') ack({ success: true, message: msg.toJSON() });
        } catch (error) {
          console.error('Error sending message:', error.message);
          if (typeof ack === 'function') ack({ success: false, error: error.message });
          else socket.emit('chat_error', { error: error.message });
        }
      });

      socket.on('disconnect', () => {
        console.log('❌ Socket disconnected:', socket.id);
      });
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      // Printed once at boot so a silently-disabled integration is a decision
      // rather than something discovered when an order goes unanswered.
      logIntegrationStatus();
      // Once the DB is up and the server is listening.
      require('./jobs/pharmacyOrderTimeoutJob').start();
      require('./jobs/appointmentRequestTimeoutJob').start();
      require('./jobs/labSlotRollJob').start();
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Without these, one unhandled rejection or uncaught exception anywhere in
// this large codebase silently kills the process for every pharmacy at once,
// with no log trail. Exiting (rather than continuing) is deliberate — process
// state after an uncaught exception can't be trusted — so this must run under
// a supervisor (pm2/systemd) configured to restart on exit; see ecosystem
// config / package.json for the pm2 setup.
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

startServer();
