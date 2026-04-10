const fs = require('fs')
const path = require('path')

exports.default = async function(context) {
  const platform = context.electronPlatformName

  if (platform === 'darwin') {
    const src = path.join(__dirname, 'install-onit.command')
    const dest = path.join(context.appOutDir, '安装 Onit.command')
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      fs.chmodSync(dest, 0o755)
      console.log(`  • copied install script to ${dest}`)
    }
  } else if (platform === 'win32') {
    const src = path.join(__dirname, 'install-onit.bat')
    const dest = path.join(context.appOutDir, 'install-onit.bat')
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      console.log(`  • copied install script to ${dest}`)
    }
  }
}
