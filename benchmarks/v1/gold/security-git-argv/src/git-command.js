exports.checkoutCommand = branch => ({ bin: 'git', args: ['checkout','--',String(branch)] });
