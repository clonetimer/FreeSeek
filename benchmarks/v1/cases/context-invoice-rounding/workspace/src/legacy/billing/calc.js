exports.invoiceTotal = items => items.reduce((s,x)=>s+x.price*x.qty,0);
