import {CardboardClient} from '../src/index.js';
const client=new CardboardClient();
console.log(await client.getMarkets());
if(process.argv[2]){
  console.log(await client.getAccount(process.argv[2]));
  console.log(await client.getPositions(process.argv[2]));
  console.log(await client.getHistory(process.argv[2]));
}
