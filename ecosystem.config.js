module.exports = {
  apps: [
    {
        name: "esima-core",
        cwd: "./apps/core", 
        script: "./dist/server.js",
        instances: 1, 
        exec_mode: "fork",
        watch: false,
        env_production: {
            NODE_ENV: "production",
            PORT: 4000,
            WORKER_COUNT: "4"
        },
        output: './logs/out.log',
        error: './logs/error.log',
        log_date_format:"YYYY-MM-DD HH:mm:ss",
        merge_logs: true
    },
    {
      name: "esima-panel",
      cwd: "./apps/panel",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      instances: "4", 
      exec_mode: "cluster",
      watch: false,
      env_production: {
        NODE_ENV: "production",
        PORT: 3000
      },
      output: './logs/out.log',
      error: './logs/error.log',
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true
    }
  ]
};