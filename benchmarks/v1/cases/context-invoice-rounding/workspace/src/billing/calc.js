exports.invoiceTotal = function(items) {
  return items.reduce((sum,item)=>sum + Math.round(item.price * item.qty * 100) / 100, 0);
};
