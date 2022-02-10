import cp from 'child_process'
import { LogLevel, SocketDebugClient } from 'node-debugprotocol-client'
import fs from 'fs'
import path from 'path'
import { DebugProtocol } from 'vscode-debugprotocol'
import { logger } from '../logger'
import { MakeRunnerParams, makeRunner, RunnerOptions } from './runner'

type Language = 'C' | 'C++'

export const runStepsWithLLDB = (language: Language, options: RunnerOptions) => {
  const config = configurations[language]
  let executablePath: string | null = null
  const runner = makeRunner({
    connect: connect(language, config, (exe) => executablePath = exe),
    canDigScope: (scope) => {
      // if (this.language === 'C++')
      const forbiddenScopes = ['Registers', 'Static']
      return !forbiddenScopes.includes(scope.name)
    },
    afterDestroy: async () => {
      logger.debug('[LLDB StepsRunner] remove executable file')
      if (executablePath) await fs.promises.unlink(executablePath).catch(() => {/* throws if already deleted */})
    },
  })
  return runner(options)
}

const connect = (
  language: Language,
  config: Configuration,
  onExecutablePath: (thePath: string) => void,
): MakeRunnerParams['connect'] => async ({ beforeInitialize, logLevel, processes, programPath }) => {
  const dap = {
    host: 'localhost',
    port: 4711,
  }

  logger.debug(1, '[LLDB StepsRunner] start adapter server')
  await spawnAdapterServer(dap, processes)
  
  logger.debug(2, '[LLDB StepsRunner] instantiate SocketDebugClient')
  const client = new SocketDebugClient({
    host: dap.host,
    port: dap.port,
    loggerName: `${language} debug adapter client`,
    logLevel,
  })

  logger.debug(3, '[LLDB StepsRunner] register events')
  beforeInitialize(client)
  
  logger.debug(4, '[LLDB StepsRunner] connect adapter')
  await client.connectAdapter()
  
  logger.debug(5, '[LLDB StepsRunner] initialize client')
  await client.initialize({
    adapterID: language,
    pathFormat: 'path',
  })

  const executablePath = config.compile(programPath).executablePath
  onExecutablePath(executablePath)

  const spawnedTerminalRequest = new Promise<void>((resolve, reject) => {
    client.onRunInTerminalRequest(async ({ args: [argv, ...args], cwd, env, kind, title }) => {
      if (!argv) throw new Error('argv must be defined')
      logger.debug('[Event] RunInTerminalRequest', { argv, args, cwd, kind, title })
      const subprocess = cp.spawn(argv, args, {
        stdio: 'inherit',
        env: { ...env, RUST_BACKTRACE: 'full' },
        shell: true,
      })
      processes.push(subprocess)
      subprocess.on('error', (error) => {
        logger.error(error)
        reject(error)
      })
      // resolve()
      logger.debug(7, '[LLDB StepsRunner] ran requested command in terminal')
      setTimeout(resolve, 1)
      // subprocess.stdout.on('data', (data) => logger.debug('[stdout]', data.toString('utf-8')))
      // subprocess.stderr.on('data', (data) => logger.debug('[stderr]', data.toString('utf-8')))
      return { processId: subprocess.pid, shellProcessId: process.pid }
    })
  })

  logger.debug(6, '[LLDB StepsRunner] launch client')
  const launched = client.launch({
    program: executablePath,
    ...config.launchArgs,
  } as DebugProtocol.LaunchRequestArguments)

  await Promise.race([ launched, spawnedTerminalRequest ])

  return { client }
}

async function spawnAdapterServer(dap: { host: string, port: number }, processes: cp.ChildProcess[]): Promise<void> {
  logger.debug('Start LLDB DAP Server on port', dap.port)

  const root = path.join(process.cwd(), 'vscode-lldb')
  const liblldb = path.join(root, './lldb/lib/liblldb.so')
  logger.debug('Start LLDB DAP Server on port', dap.port)

  const executable = path.join(root, 'adapter/codelldb');
  const args = ['--liblldb', liblldb, '--port', dap.port.toString()];

  await new Promise<void>((resolve) => {
    const adapter = cp.spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    })
    processes.push(adapter)
    const resolveOnMessage = (origin: string) => (data: any) => {
      const message = data.toString('utf-8')
      logger.debug(`DAP server ready (${origin})`, message)
      if (message.startsWith('Listening on port')) resolve()
    }
    adapter.stdout.once('data', resolveOnMessage('stdout'))
    adapter.stderr.once('data', resolveOnMessage('stderr'))
    if (logger.level === 'debug') adapter.stdout.on('data', (data) => process.stdout.write(data))
    if (logger.level === 'debug') adapter.stderr.on('data', (data) => process.stderr.write(data))
  })
}

interface Configuration {
  compile: (mainFilePath: string) => { executablePath: string },
  launchArgs?: DebugProtocol.LaunchRequestArguments
}
const configurations: Record<Language, Configuration> = {
  C: {
    compile: (mainFilePath) => {
      // execSync(disableASLRCommand(), { stdio: 'inherit' })
      const executablePath = removeExt(mainFilePath)
      cp.execSync(`gcc -g ${mainFilePath} -o ${executablePath}`, { stdio: 'inherit' })
      return { executablePath }
    },
    launchArgs: {
      initCommands: ['settings set target.disable-aslr false']
    } as DebugProtocol.LaunchRequestArguments
  },
  'C++': {
    compile: (mainFilePath) => {
      const executablePath = removeExt(mainFilePath)
      cp.execSync(`g++ -g ${mainFilePath} -o ${executablePath}`, { stdio: 'inherit' })
      return { executablePath }
    },
  },
}
const removeExt = (filePath: string) => filePath.slice(0, -path.extname(filePath).length)
