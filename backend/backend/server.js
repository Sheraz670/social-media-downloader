
const express=require("express");
const cors=require("cors");
const {Readable}=require("stream");

const app=express();
const PORT=process.env.PORT||3000;

app.use(cors({origin:"*"}));
app.use(express.json());

const ALLOWED_TYPES=[
  "video/mp4","video/webm","video/quicktime",
  "audio/mpeg","audio/mp3","audio/mp4","audio/webm",
  "image/jpeg","image/png","image/webp"
];

function isValidHttpUrl(value){
  try{const u=new URL(value);return u.protocol==="http:"||u.protocol==="https:"}
  catch{return false}
}

function isPrivateHostname(hostname){
  const host=hostname.toLowerCase();
  if(host==="localhost"||host==="127.0.0.1"||host==="::1")return true;
  if(host.startsWith("10.")||host.startsWith("192.168.")||host.startsWith("169.254."))return true;
  if(host.startsWith("172.")){const second=Number(host.split(".")[1]);if(second>=16&&second<=31)return true}
  return false;
}

async function getRemoteHeaders(url){
  const parsed=new URL(url);
  if(isPrivateHostname(parsed.hostname))throw new Error("Private/local URLs are not allowed.");
  const response=await fetch(url,{method:"HEAD",redirect:"follow"});
  if(!response.ok)throw new Error(`Remote server returned HTTP ${response.status}.`);
  return response.headers;
}

app.get("/",(req,res)=>res.json({service:"SocialToolHub Media API",status:"online"}));

app.get("/api/media",async(req,res)=>{
  try{
    const url=req.query.url;
    if(!url)return res.status(400).json({error:"Missing url parameter."});
    if(!isValidHttpUrl(url))return res.status(400).json({error:"Invalid HTTP/HTTPS URL."});
    const headers=await getRemoteHeaders(url);
    const contentType=headers.get("content-type")||"";
    const contentLength=headers.get("content-length");
    const normalizedType=contentType.split(";")[0].toLowerCase();
    if(!ALLOWED_TYPES.includes(normalizedType))
      return res.status(415).json({error:"This URL does not point directly to a supported media file."});
    let size="Unknown";
    if(contentLength){const bytes=Number(contentLength);if(!Number.isNaN(bytes))size=`${(bytes/(1024*1024)).toFixed(2)} MB`}
    const filename=decodeURIComponent(new URL(url).pathname.split("/").pop()||"media-file");
    res.json({title:filename,contentType:normalizedType,size,downloadable:true});
  }catch(error){console.error(error);res.status(500).json({error:error.message||"Unable to inspect this media URL."})}
});

app.get("/api/download",async(req,res)=>{
  try{
    const url=req.query.url;
    if(!url)return res.status(400).json({error:"Missing url parameter."});
    if(!isValidHttpUrl(url))return res.status(400).json({error:"Invalid URL."});
    const parsed=new URL(url);
    if(isPrivateHostname(parsed.hostname))return res.status(403).json({error:"Private/local URLs are not allowed."});
    const remoteResponse=await fetch(url,{redirect:"follow"});
    if(!remoteResponse.ok)return res.status(remoteResponse.status).json({error:`Remote server returned HTTP ${remoteResponse.status}.`});
    const contentType=remoteResponse.headers.get("content-type")||"application/octet-stream";
    const normalizedType=contentType.split(";")[0].toLowerCase();
    if(!ALLOWED_TYPES.includes(normalizedType))return res.status(415).json({error:"Unsupported media type."});
    const filename=decodeURIComponent(parsed.pathname.split("/").pop()||"download").replace(/[^a-zA-Z0-9._-]/g,"_");
    res.setHeader("Content-Type",contentType);
    res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
    const contentLength=remoteResponse.headers.get("content-length");
    if(contentLength)res.setHeader("Content-Length",contentLength);
    if(!remoteResponse.body)return res.status(500).json({error:"Remote server returned no media stream."});
    Readable.fromWeb(remoteResponse.body).pipe(res);
  }catch(error){
    console.error(error);
    if(!res.headersSent)res.status(500).json({error:error.message||"Download failed."});
  }
});

app.listen(PORT,()=>console.log(`SocialToolHub API running on port ${PORT}`));
    
