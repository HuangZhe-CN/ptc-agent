import React from 'react'

/**
 * Task 20 最小骨架：agentView 三层结构（Header / Scroll / Dock），
 * 对应 tokens.css 的 grid-template-rows: auto minmax(0,1fr) auto。
 * Header/Composer/Timeline 内容由 Task 21+ 填充。
 */
export function AgentView(): JSX.Element {
  return (
    <section className="agentView">
      <header className="agentHeader" />
      <div className="agentScroll">
        <div className="timeline" />
      </div>
      <div className="agentDock" />
    </section>
  )
}
