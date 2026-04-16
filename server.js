const dotenv = require('dotenv');
dotenv.config();

const http = require('http');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const app = require('./app'); // We will start the app after the DB is connected
const ChatMessage = require('./models/ChatMessage');
const ChatSession = require('./models/ChatSession');

const startServer = async () => {
  try {
    // 1. Wait for the database to connect successfully
    await connectDB();
    console.log('✅ MongoDB Connected');

    // 2. Now that the DB is ready, start the Express server
    const PORT = process.env.PORT || 5000;
    
    // Create HTTP Server
    const server = http.createServer(app);
    
    // Setup Socket.IO
    const io = new Server(server, {
      cors: {
        origin: '*',
      }
    });

    // Handle Socket Connections
    io.on('connection', (socket) => {
      console.log('🔌 New Socket Connection:', socket.id);

      // Join a chat room specific to the session
      socket.on('join_chat', (data) => {
        const { sessionId } = data;
        if (sessionId) {
          socket.join(sessionId);
          console.log(`User joined session room: ${sessionId}`);
        }
      });

      // Handle sending messages
      socket.on('send_message', async (data) => {
        try {
          const { sessionId, senderId, senderType, content, messageType = 'text', fileUrl } = data;

          if (!sessionId || !senderId || !content) {
            return socket.emit('error', 'Missing required fields for message');
          }

          // Create new chat message
          const msg = await ChatMessage.create({
            sessionId,
            senderId,
            senderType,
            content,
            messageType,
            fileUrl,
            isRead: false
          });

          // Update session lastMessage
          await ChatSession.findByIdAndUpdate(sessionId, {
            lastMessage: msg._id,
            updatedAt: new Date()
          });

          // Broadcast to everyone in the room (including sender to confirm)
          io.to(sessionId).emit('receive_message', msg.toJSON());
          
          // Optionally, we could also emit to a global user room to notify them if they aren't in the chat view

        } catch (error) {
          console.error('Error sending message:', error);
          socket.emit('error', 'Failed to send message');
        }
      });

      socket.on('disconnect', () => {
        console.log('❌ Socket disconnected:', socket.id);
      });
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1); // Exit if the server can't start
  }
};

startServer();