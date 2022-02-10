import cp from 'child_process'
import fs from 'fs'
import path from 'path'
import { LogLevel, SocketDebugClient, Unsubscribable } from 'node-debugprotocol-client'
import { DebugProtocol } from 'vscode-debugprotocol'
import { logger } from '../logger'

export interface MakeRunnerParams {
  connect: (input: {
    processes: cp.ChildProcess[],
    subscribers: Unsubscribable[],
    programPath: string,
    logLevel: LogLevel,
    beforeInitialize: (client: SocketDebugClient) => void,
  }) => Promise<{ client: SocketDebugClient }>

  canDigVariable?: (variable: DebugProtocol.Variable) => boolean
  canDigScope?: (scope: DebugProtocol.Scope) => boolean

  afterDestroy?: () => Promise<void>
}
interface File {
  relativePath: string,
}
export interface RunnerOptions {
  main: File
  files: Array<File>
  logLevel?: 'On' | 'Off',
}

export const makeRunner = ({
  connect,
  afterDestroy = Promise.resolve,
  canDigScope = () => true,
  canDigVariable = () => true,
}: MakeRunnerParams) => {
  let destroyed = false
  const stepsAcc: Steps = []
  let resolveSteps: () => void = () => {}
  const steps = new Promise<Steps>((resolve) => {
    resolveSteps = () => resolve(stepsAcc)
  })
  return async (options: RunnerOptions) => {
    const processes: cp.ChildProcess[] = []
    const subscribers: Unsubscribable[] = []
    const programPath = path.resolve(process.cwd(), options.main.relativePath)

    logger.debug(1, '[runner] connect()')
    const { client } = await connect({
      processes,
      subscribers,
      programPath,
      logLevel: LogLevel[options.logLevel ?? 'Off'],
      beforeInitialize: (client) => registerEvents(client, resolveSteps),
    })

    const subscriber = client.onStopped(async (stoppedEvent) => {
      logger.debug('[Event] Stopped', stoppedEvent);
      const reasons = ['breakpoint', 'step']
      if (!reasons.includes(stoppedEvent.reason) || typeof stoppedEvent.threadId !== 'number') return
      setSnapshotAndStepIn({
        client,
        programPath,
        stepsAcc,
        filePaths: [options.main, ...options.files].map((file) => path.resolve(process.cwd(), file.relativePath)),
        canDigScope,
        canDigVariable,
        threadId: stoppedEvent.threadId,
      })
    })
    subscribers.push(subscriber)

    logger.debug(2, '[runner] setBreakpoints()')
    await setBreakpoints({ client, programPath })

    logger.debug(3, '[runner] Configuration Done')
    // send 'configuration done' (in some debuggers this will trigger 'continue' if attach was awaited)
    await client.configurationDone({})

    logger.debug(4, '[runner] await steps')
    const result = await steps
    const filtered = result.map((snapshot) => ({
      ...snapshot,
      stackFrames: snapshot.stackFrames.filter((frame) => frame.source?.path === programPath),
    })).filter(({ stackFrames }) => stackFrames.length > 0)
    logger.dir({ steps: filtered }, { colors: true, depth: 20 })

    logger.debug(5, '[runner] destroy')
    try {
      await destroy('runSteps', { destroyed, client, processes, programPath, subscribers, afterDestroy })
    } catch {
      // silence is golden.
    }
    
    logger.debug(6, '[runner] return result')
    return result
  }
}
export type Steps = StepSnapshot[]
export interface StepSnapshot {
  stackFrames: StackFrame[]
}
export interface StackFrame extends DebugProtocol.StackFrame {
  scopes: Scope[]
}
export interface Scope extends DebugProtocol.Scope {
  variables: Variable[]
}
export interface Variable extends DebugProtocol.Variable {
  variables: Variable[]
}

interface DestroyParams {
  client: SocketDebugClient,
  destroyed: boolean
  processes: cp.ChildProcess[],
  subscribers: Unsubscribable[],
  programPath: string,
  afterDestroy: () => Promise<void>,
}
async function destroy(origin: string, { destroyed, subscribers, processes, client, afterDestroy }: DestroyParams): Promise<void> {
  if (destroyed) return logger.debug('[StepsRunner] destroy already performed')
  
  logger.debug('\n')
  logger.debug(`[StepsRunner] Destroy ⋅ ${origin}`)
  subscribers.forEach((subscriber) => subscriber.unsubscribe())
  processes.forEach((subprocess) => {
    if (!subprocess.killed) subprocess.kill()
  })
  client.disconnectAdapter()
  await client.disconnect({}).catch(() => {/* throws if already disconnected */})
  await afterDestroy()
  destroyed = true
}

interface SetBreakpointsParams {
  client: SocketDebugClient,
  programPath: string,
}
async function setBreakpoints({ client, programPath }: SetBreakpointsParams): Promise<void> {
  const programCode = await fs.promises.readFile(programPath, 'utf-8')
  const lines = programCode.split('\n').length

  logger.debug('[StepsRunner] set breakpoints')
  let response = await client.setBreakpoints({
    breakpoints: Array.from({ length: lines }, (_, i) => ({ line: i + 1 })),
    source: {
      path: programPath
    }
  })
  logger.debug('[StepsRunner] set breakpoints intermediate response', response)

  const verifiedBreakpoints = response.breakpoints
    .filter((breakpoint) => breakpoint.verified && typeof breakpoint.line === 'number')
    .map(({ line }) => ({ line: line as number }))

  if (verifiedBreakpoints.length === lines) return

  response = await client.setBreakpoints({
    breakpoints: verifiedBreakpoints,
    source: { path: programPath },
  })

  logger.debug('[StepsRunner] set breakpoints response', response)
}

const registerEvents = (client: SocketDebugClient, resolveSteps: () => void): void => {
  client.onContinued((event) => logger.debug('[Event] Continued', event))
  client.onExited((event) => {
    logger.debug('[Event] Exited', event.exitCode)
    if (event.exitCode === 0) resolveSteps()
  })
  client.onOutput(({ output, ...event }) => logger.debug('[Event] Output', JSON.stringify(output), event))
  client.onTerminated(async (event) => {
    logger.debug('[Event] Terminated − resolve steps', event ?? '')
    resolveSteps()
    client.disconnectAdapter();
  });

  client.onThread((thread) => {
    logger.debug('[Event] Thread', thread)
  })
}

interface SetSnapshotAndStepInParams {
  stepsAcc: Steps,
  programPath: string,
  client: SocketDebugClient,
  /** absolute paths */
  filePaths: string[],
  canDigVariable: GetSnapshotParams['canDigVariable'],
  canDigScope: GetSnapshotParams['canDigScope'],
  threadId: GetSnapshotParams['threadId'],
}
async function setSnapshotAndStepIn({ client, programPath, stepsAcc, filePaths, canDigScope, canDigVariable, threadId }: SetSnapshotAndStepInParams): Promise<void> {
  const i = stepsAcc.length
  try {
    logger.debug('Execute steps', i)
    const snapshot = await getSnapshot({ client, filePaths, canDigScope, canDigVariable, threadId })
    logger.dir({ snapshot }, { colors: true, depth: 10 })
    if (snapshot.stackFrames.length > 0) stepsAcc.push(snapshot)
    // logger.debug('StepIn', i, stepsAcc[i-1]?.stackFrames[0]?.source ?? '')
    // logger.debug('Source', i, { sourcePath: snapshot.stackFrames[0]?.source?.path, programPath })
    snapshot.stackFrames.some(isStackFromOfSourceFile(filePaths))
      ? await client.stepIn({ threadId, granularity: 'instruction' })
      : await client.stepOut({ threadId, granularity: 'instruction' })
  } catch (error) {
    logger.debug('Failed at step', i, error)
  }
}

interface GetSnapshotParams {
  client: SocketDebugClient,
  /** absolute paths */
  filePaths: string[],
  canDigVariable: GetStackFrameParams['canDigVariable'],
  canDigScope: GetStackFrameParams['canDigScope'],
  threadId: number
}
async function getSnapshot({ client, filePaths, canDigScope, canDigVariable, threadId }: GetSnapshotParams): Promise<StepSnapshot> {
  const result = await client.stackTrace({ threadId });
  logger.dir({ filePaths })
  const stackFrames = await Promise.all(
    result.stackFrames
      .filter(isStackFromOfSourceFile(filePaths))
      .map((stackFrame) => getStackFrame({
        client,
        canDigScope,
        canDigVariable,
        stackFrame,
      }))
  )
  return { stackFrames }
}

interface GetStackFrameParams {
  client: SocketDebugClient,
  stackFrame: DebugProtocol.StackFrame,
  canDigVariable: GetScopeParams['canDigVariable'],
  canDigScope: GetScopeParams['canDigScope'],
}
async function getStackFrame({ canDigScope, canDigVariable, client, stackFrame }: GetStackFrameParams): Promise<StackFrame> {
  const result = await client.scopes({ frameId: stackFrame.id })
  const scopes = await Promise.all(result.scopes.map((scope) => getScope({
    client,
    canDigScope,
    canDigVariable,
    scope,
  })))
  return { ...stackFrame, scopes }
}

interface GetScopeParams {
  canDigVariable: GetVariableParams['canDigVariable'],
  canDigScope: (scope: DebugProtocol.Scope) => boolean,
  scope: DebugProtocol.Scope,
  client: SocketDebugClient,
}
async function getScope({ client, canDigScope, canDigVariable, scope }: GetScopeParams): Promise<Scope> {
  if (!canDigScope(scope)) return { ...scope, variables: [] }
  const result = await client.variables({ variablesReference: scope.variablesReference })
  const isLocalScope = scope.name.startsWith('Local')
  const variablesMaxDepth = isLocalScope ? 3 : 0
  // logger.dir({ scope, result })
  const variables = await Promise.all(result.variables.map((variable) => getVariable({
    client,
    canDigVariable,
    variable,
    maxDepth: variablesMaxDepth,
  })))
  return { ...scope, variables }
}

interface GetVariableParams {
  client: SocketDebugClient,
  variable: DebugProtocol.Variable,
  canDigVariable: (variable: DebugProtocol.Variable) => boolean,
  maxDepth: number,
}
async function getVariable({ client, canDigVariable, maxDepth, variable }: GetVariableParams, currentDepth = 0): Promise<Variable> {
  const shouldGetSubVariables = variable.variablesReference > 0 && currentDepth <= maxDepth && canDigVariable(variable)
  if (!shouldGetSubVariables) return { ...variable, variables: [] }
  try {
    const result = await client.variables({ variablesReference: variable.variablesReference })
    const variables = await Promise.all(result.variables.map((variable) => getVariable({ client, canDigVariable, variable, maxDepth }, currentDepth + 1)))
    return { ...variable, variables }
  } catch (error) {
    logger.dir({ variable, error })
    return { ...variable, variables: [] }
  }
}

function isStackFromOfSourceFile(fileAbsolutePaths: string[]) {
  return (stackFrame: DebugProtocol.StackFrame) => {
    return !!stackFrame.source && fileAbsolutePaths.some((filePath) => filePath === stackFrame.source?.path)
  }
}
