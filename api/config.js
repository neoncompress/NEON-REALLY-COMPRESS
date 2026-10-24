import {db,settings,handler,method} from '../lib/core.js';
export default async function(req,res){if(!method(req,res,['GET']))return;await handler(req,res,async()=>{const s=await settings(await db());res.json({dailyLimit:s.dailyLimit,limitEnabled:s.limitEnabled,maintenance:s.maintenance,pointPackages:s.pointPackages,sizePricing:s.sizePricing,payments:s.payments});});}
