export type User={id:string;name:string;role:string;status:string;grants:any[];setupRequired?:boolean};
export function csrf(){return decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('filtarr_csrf='))?.split('=')[1]??'');}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(path,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(!['GET','HEAD'].includes(options.method??'GET')?{'X-Filtarr-CSRF':csrf()}:{}),...(options.headers??{})},credentials:'include'});
  if(!response.ok){let data:any={};try{data=await response.json();}catch{}throw Error(data.error??`${response.status} ${response.statusText}`);}
  return response.json();
}
export const post=<T=any>(path:string,value:unknown)=>api<T>(path,{method:'POST',body:JSON.stringify(value)});
export const put=<T=any>(path:string,value:unknown)=>api<T>(path,{method:'PUT',body:JSON.stringify(value)});
export const del=<T=any>(path:string)=>api<T>(path,{method:'DELETE'});
