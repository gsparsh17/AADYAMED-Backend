// pm2 process-supervisor config. Run with: npm run start:prod
// This is what actually makes the crash guards in server.js meaningful — an
// uncaughtException/unhandledRejection exits the process on purpose, and pm2
// is what restarts it automatically instead of the whole API just staying down.
module.exports = {
  apps: [
    {
      name: 'aadyamed-backend',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
