const DEFAULTS={newCheckout:true,expressPay:false};
exports.resolveFlags=(env={})=>({...DEFAULTS,...env});
