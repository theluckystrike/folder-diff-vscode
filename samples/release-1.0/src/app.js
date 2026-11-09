const { loadSales } = require('./util');

function main(args) {
  const rows = loadSales('data/sales.csv');
  const total = rows.reduce((s, r) => s + r.units * r.price, 0);
  console.log('Total revenue:', total.toFixed(2));
}

main(process.argv.slice(2));
