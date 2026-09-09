const { spawn } = require('node:child_process')

const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const electronPath = require('electron')
const child = spawn(electronPath, ['.'], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
  windowsHide: false,
})

child.once('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
