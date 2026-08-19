exports.invoiceTotal = function(items) {
  const total = items.reduce((sum,item)=>sum + item.price * item.qty, 0);
  return Math.round((total + Number.EPSILON) * 100) / 100;
};
