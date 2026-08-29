import { Controls, Player } from "@lottiefiles/react-lottie-player"
import { Flex, Typography } from "antd"

const { Title } = Typography

export const EmptyData = ({title,description})=>{
    return (
        <Flex vertical className="w-full !h-full" justify="center" align="center">
            <Player
                autoplay
                loop
                src="/app_assets/anims/notFound.json"
                style={{width:'auto',height:180,borderRadius:12}}
            >
                <Controls visible={false} buttons={['play', 'repeat', 'frame', 'debug']} />
            </Player>
            <Title
                className="mb-0 mt-4 !text-textBase"
                level={4}
            >
                {title}
            </Title>
            <span className="!text-textSecondary">{description}</span>
        </Flex>
    )
}