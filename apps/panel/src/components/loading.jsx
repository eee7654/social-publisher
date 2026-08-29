"use client";

import { motion } from "framer-motion";
import { AuroraBackground } from "./ui/aurora-background";
import { Controls, Player } from "@lottiefiles/react-lottie-player";
import { DotBackground } from "./ui/dot-background";
import { Flex, Image, Typography } from "antd";

const {
  Title
} = Typography

export const Splash = ()=> {
  return (
    <AuroraBackground dir="rtl">
      <motion.div
        initial={{ opacity: 0.0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{
          delay: 0.3,
          duration: 0.8,
          ease: "easeInOut",
        }}
        className="relative flex flex-col gap-4 items-center justify-center px-4"
      >
        <Flex vertical style={{direction:'ltr'}} className="" justify={'center'} align={'center'} >
          <Image
            preview={false}
            src={'/app_assets/img/branding.svg'}
            width={124}
            height={124}
            className=""
          />
          <Flex vertical justify={'space-around'} align={'center'} className="mt-5 !h-full">
            <Title level={2} className="!text-primaryLight !mb-0" style={{fontFamily:'monospace',opacity:'0.85'}}>{'ELECIO'}</Title>
            <Title level={4} className="!text-seconary !mt-0 !mb-0" style={{fontFamily:'monospace',opacity:'0.7'}}>{'SMART DNC'}</Title>
          </Flex>
        </Flex>
      </motion.div>
    </AuroraBackground>
  );
}

export const FallBackWaiting = ()=>{
  return(
    <div style={{width:'100%',height:'100vh',padding:0,margin:0}}>
      <DotBackground>
        <div style={{display:'flex',flexDirection:'column',justifyContent:'center',alignItems:'center',width:'100%',height:'100%'}}>
          <Loading />
          <span style={{fontFamily:'monospace',fontSize:28,fontWeight:700,marginLeft:-4,marginRight:0,marginTop:-24,color:'#4C575D'}}>{'APPCLI'}</span>
        </div>
      </DotBackground>
    </div>
  )
}

export const Loading = ({className})=>{
  return (
    <Flex vertical justify="center" align="center" className={className ?? ''}>
      <Player
        autoplay
        loop
        src="/app_assets/anims/loading.json"
        style={{width:150,height:'auto',borderRadius:12}}
      >
        <Controls visible={false} buttons={['play', 'repeat', 'frame', 'debug']} />
      </Player>
    </Flex>
  )
}
