const fs = require('fs')
const path = require('path')

exports.default = async function(context) {
  const scriptName = '安装 Onit.command'
  const src = path.join(__dirname, 'install-onit.command')
  const dest = path.join(context.appOutDir, scriptName)

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest)
    fs.chmodSync(dest, 0o755)
    console.log(`  • copied install script to ${dest}`)
  }
}
