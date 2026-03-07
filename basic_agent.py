
import os
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentSession, RunContext
from livekit.agents.llm import function_tool
from livekit.plugins import openai, deepgram, silero

load_dotenv(".env")

class Assistant(Agent):
    """Basic Voice assistant agent for tutoring"""

    def __init__(self):
        super().__init__(
            instructions = """You are a helpful and friendly voice assistant that responds to the users requests and helps them learn WHEN ASKED."""
        )


    @function_tool
    async def get_date_time(self, context: RunContext):
        """Get the current date and time"""

        from datetime import datetime

        now = datetime.now()
        return now.strftime("%Y-%m-%d %H:%M:%S")
async def entrypoint(ctx: agents.JobContext):
    """Entry point for agent"""

    session = AgentSession(
        stt = deepgram.STT(model="nova-2"),
        llm = openai.LLM(model=os.getenv("LLM_CHOICE", "gpt-4.1-mini")),
        tts = openai.TTS(voice="echo"),
        vad = silero.VAD.load(),    
    )

    await session.start(
        room = ctx.room,
        agent = Assistant()
    )

    await session.generate_reply(
        instructions = "Greet the user warmly and ask how ou can help."
    )


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))