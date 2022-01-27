// @ts-check
import path from 'path'
import cp from 'child_process'

// const escapeBashString = (string) => `"${string.replace(/([\$"])/g, '\\$1')}"`

/**
 * Call script
 * @param {string} mainFilePath path to main file of the project to debug
 * @param {?import('./src/logger').LoggerLevel} logLevel
 * @returns {Promise<string>} rawJSON
 */
export async function callScript(mainFilePath, logLevel = 'off') {
  const fileExtension = path.extname(mainFilePath)
  const docker = dockerRunConfigs[fileExtension]
  if (!docker) throw new Error(`Unknown extension "${fileExtension}". Accepted: "${Object.keys(dockerRunConfigs).join('", "')}"`)

  const { command, args } = dockerRunCommand(docker, mainFilePath, logLevel)

  const json = new Promise((resolve, reject) => {
    process.on('error', (error) => {
      console.error('process error:', error)
      reject(error)
    })

    const begin = 'RESULT_BEGIN'
    const end = 'RESULT_END'
    let raw = ''
    const onData = (data) => {
      let message = data.toString('utf-8')
      if (message.includes(begin)) {
        message = message.slice(message.indexOf(begin) + begin.length)
        if (!message.includes(end)) raw += message
      }
      if (message.includes(end)) {
        message = message.slice(0, message.indexOf(end))
        resolve((raw + message).trim())
        process.stdout.off('data', onData)
      }
    }
    process.stdout.on('data', onData)
  })

  console.info('command\n', [command, ...args].join(' \\\n  '))
  cp.spawnSync(command, args, { stdio: 'inherit' })
  
  const rawJSON = await json
  return rawJSON
}

/**
 * @typedef {'lldb-debugger'|'php-debugger'|'python-debugger'} DockerImage
 */

/**
 * @typedef DockerRunConfig
 * @property {DockerImage} image
 */

/** @type {Record<import('./src/StepsRunner/factory').LanguageExtension, DockerRunConfig>} */
const dockerRunConfigs = {
  '.c': {
    image: 'lldb-debugger',
  },
  '.cpp': {
    image: 'lldb-debugger',
  },
  '.php': {
    image: 'php-debugger',
  },
  '.py': {
    image: 'python-debugger',
  }
}

/**
 * Returns the docker run command
 * @param {DockerRunConfig} docker
 * @param {string} mainFilePath
 * @param {import('./src/logger').LoggerLevel} logLevel
 * @returns {{ command: string, args: string[] }}
 */
const dockerRunCommand = (docker, mainFilePath, logLevel) => {
  const projectPath = path.dirname(mainFilePath)
  const command = 'docker'
  const args = [
    'run',
    '-it',
    '--rm',
    '--env',
    `LOG_LEVEL=${logLevel}`,
    ...mountsPerImage[docker.image].flatMap(toDockerMountArgs),
    ...toDockerMountArgs({ source: paths.output(paths.selfRoot), target: paths.output(paths.dockerRoot) }),
    ...toDockerMountArgs({ source: paths.nodeModules(paths.selfRoot), target: paths.nodeModules(paths.dockerRoot) }),
    ...toDockerMountArgs({ source: path.resolve(paths.selfRoot, projectPath), target: path.resolve(paths.dockerRoot, projectPath) }),
    docker.image,
    mainFilePath,
  ].filter(Boolean)
  return { command, args }
}

const paths = {
  dockerRoot: '/usr/project',
  selfRoot: process.cwd(),
  sources: (root) => path.resolve(root, './sources'),
  output: (root) => path.resolve(root, './out'),
  nodeModules: (root) => path.resolve(root, './node_modules'),
  packageJson: (root) => path.resolve(root, './package.json'),
  packageLock: (root) => path.resolve(root, './package-lock.json'),

  vscodeLldb: (root) => path.resolve(root, './vscode-lldb'),
  vscodePhpDebug: (root) => path.resolve(root, './vscode-php-debug'),
  // vscodeCppTools: (root) => path.resolve(root, './vscode-cpptools'),
}

/**
 * @typedef DockerMount
 * @property {'bind'} [type]
 * @property {string} source
 * @property {string} target
 * @property {boolean} [readOnly]
 */

/** @type {Record<DockerImage, DockerMount[]>} */
const mountsPerImage = {
  // 'gdb-debugger': [],
  'lldb-debugger': [
    { source: paths.vscodeLldb(paths.selfRoot), target: paths.vscodeLldb(paths.dockerRoot) },
  ],
  'php-debugger': [
    { source: paths.vscodePhpDebug(paths.selfRoot), target: paths.vscodePhpDebug(paths.dockerRoot) },
  ],
  'python-debugger': [],
}

/**
 * 
 * @param {DockerMount} mount 
 * @returns {['--mount', string]} arguments for "--mount"
 */
const toDockerMountArgs = ({ type = 'bind', source, target, readOnly }) => {
  const arg = [
    `type=${type}`,
    `source=${source}`,
    `target=${target}`,
    readOnly && 'readonly',
  ].filter(Boolean).join(',')
  return ['--mount', arg]
}
