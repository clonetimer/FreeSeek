const {defaults}=require('./defaults'); exports.options=(user={})=>({...defaults,...user});
