import { randomBytes } from 'crypto'
import { duration } from 'jalali-moment'
import { generate } from 'generate-password'


export const validateEmail = (email)=>{
    var re = /\S+@\S+\.\S+/
    return re.test(email)
}

export const validatePhone = (phone)=>{
    var re = /[0][9][0-9]{9}/
    return re.test(phone)
}


export const miliSec = 1000

export const day = 24*60*60

export const week = 7*day

export const month = 30*day

export const years = (lastYear)=>{
  let years = []
  for(let i = lastYear;i >= 1300;i--){
      years.push(i)
  }
  return years
}

export const PaginationLabels = {firstPage:'ابتدا',lastPage:'انتها',nextPage:'بعدی',prevPage:'قبلی'}

export const genOtp = (opt)=>{
  return generate({
    length: opt.len,
    numbers: true,
    lowercase: opt.pass,
    uppercase: opt.pass
  })
}

export const getUploadLimit = {
  doc:2,
  avatar:1,
  picture:5,
  video:50
}

export const delay = (ms)=> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export const containsEng = (str)=>{
  return /[a-zA-Z]/.test(str)
}