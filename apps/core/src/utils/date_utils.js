import moment from "jalali-moment"

export const getNow = ()=> moment().locale('en').format('YYYY-MM-DD HH:mm')

export const getNowSec = ()=>moment().locale('en').format('YYYY-MM-DD HH:mm:ss')

export const toJalaliObj = (orgDate)=>{
    return moment(orgDate).locale('fa')
}

export const toJalaliStr = (orgDate)=>{
    return moment(orgDate).locale('fa').format('YYYY-MM-DD HH:mm')
}

export const toJalaliDateOnly = (orgDate)=>{
    return moment(orgDate).locale('fa').format('YYYY/MM/DD')
}

export const toJalaliSec = (orgDate)=>{
    return moment(orgDate).locale('fa').format('YYYY-MM-DD HH:mm:ss')
}

export const toMiladiStr = (orgDate)=>{
    return moment(orgDate).locale('en').format('YYYY-MM-DD HH:mm')
}

export const addToNowObj = (amount,unit)=>{
    return moment().add(amount,unit)
}

export const addToNowStr = (amount,unit)=>{
    return moment().add(amount,unit).format('YYYY-MM-DD HH:mm')
}

export const isBeforeDate = (date)=>{
    return moment().isBefore(moment(date))
}

export const isExpired = (date)=>{
    return moment().isAfter(moment(date))
}

export const lastYearToJalali = parseInt(moment().locale('fa').format('YYYY'))