const { loadSales } = require('./util');

function main(args) {
  const region = args[1] || 'all';
  const rows = loadSales('data/sales.csv').filter(r => region === 'all' || r.region.toLowerCase() === region);
  const total = rows.reduce((s, r) => s + r.units * r.price, 0);
  console.log(`Total revenue (${region}):`, total.toFixed(2));
}

main(process.argv.slice(2));
