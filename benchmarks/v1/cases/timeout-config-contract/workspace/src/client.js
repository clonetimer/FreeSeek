const {defaults}=require('./defaults'); exports.options=(user={})=>({...defaults,...user,timeout: user.requestTimeoutMs ?? defaults.requestTimeoutMs});
